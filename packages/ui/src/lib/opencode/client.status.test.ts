import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createRuntimeOpencodeClient, opencodeClient } from "./client"
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from "../runtime-url"

const previous = getRuntimeUrlResolver()
beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: "https://status.test" })
  opencodeClient.reconnectToRuntimeBaseUrl()
})
afterEach(() => {
  setRuntimeUrlResolver(previous)
  opencodeClient.reconnectToRuntimeBaseUrl()
})

describe("directory status HTTP boundary", () => {
  test("the SDK Request's caller signal cancels a queued command read", async () => {
    const controller = new AbortController()
    const reason = new Error("runtime changed")
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const signal = input instanceof Request ? input.signal : init?.signal
      if (!signal) throw new Error("Missing request signal")
      started()
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    })
    try {
      const sdk = createRuntimeOpencodeClient({ baseUrl: "https://status.test/api", requestTimeoutMs: 1_000 })
      const request = sdk.command.list({ directory: "/repo" }, { signal: controller.signal })
      await ready
      controller.abort(reason)
      expect(await request.then((result) => result.error, (error) => error)).toBe(reason)
    } finally {
      controller.abort()
      fetch.mockRestore()
    }
  })

  test("manual signal composition remains active after headers while the SDK reads the body", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
    const controller = new AbortController()
    const reason = new Error("body read superseded")
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const signal = input instanceof Request ? input.signal : init?.signal
      if (!signal) throw new Error("Missing request signal")
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("["))
          signal.addEventListener("abort", () => stream.error(signal.reason), { once: true })
        },
      }), { headers: { "content-type": "application/json" } })
    })
    try {
      const sdk = createRuntimeOpencodeClient({ baseUrl: "https://status.test/api", requestTimeoutMs: 1_000 })
      const request = sdk.command.list({ directory: "/repo" }, { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort(reason)
      expect(await request.then((result) => result.error, (error) => error)).toBe(reason)
    } finally {
      controller.abort()
      fetch.mockRestore()
      if (descriptor) Object.defineProperty(AbortSignal, "any", descriptor)
      else Reflect.deleteProperty(AbortSignal, "any")
    }
  })

  test("the fallback deadline bounds a body that stops arriving after successful headers", async () => {
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any")
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined })
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined })
    let aborted = false
    let calls = 0
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const signal = input instanceof Request ? input.signal : init?.signal
      if (!signal) throw new Error("Missing request signal")
      calls += 1
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode("["))
          signal.addEventListener("abort", () => { aborted = true; stream.error(signal.reason) }, { once: true })
        },
      }), { headers: { "content-type": "application/json" } })
    })
    try {
      const sdk = createRuntimeOpencodeClient({ baseUrl: "https://status.test/api", requestTimeoutMs: 20 })
      const error = await sdk.command.list({ directory: "/repo" }).then((result) => result.error, (failure) => failure)
      expect(calls).toBe(1)
      expect(aborted).toBe(true)
      expect(error).toBeDefined()
    } finally {
      fetch.mockRestore()
      if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor)
      else Reflect.deleteProperty(AbortSignal, "any")
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor)
      else Reflect.deleteProperty(AbortSignal, "timeout")
    }
  }, 1_000)

  test("rejects invalid status bodies instead of granting empty idle authority", async () => {
    const fetch = spyOn(globalThis, "fetch")
    try {
      for (const body of [null, [], { session: { type: "unknown" } }, { session: { type: "retry" } }, { "": { type: "busy" } }]) {
        fetch.mockImplementation(async () => Response.json(body))
        expect(await opencodeClient.getSessionStatusForDirectory("/workspace")).toBeNull()
      }
      fetch.mockImplementation(async () => Response.json({}))
      expect(await opencodeClient.getSessionStatusForDirectory("/workspace")).toEqual({})
    } finally {
      fetch.mockRestore()
    }
  })

  test("preserves Windows root addressing and valid retry fields through the real SDK", async () => {
    const requests: URL[] = []
    const status = { session: { type: "retry", attempt: 2, message: "Retrying", next: 1234 } }
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString()))
      return Response.json(status)
    })
    try {
      expect(await opencodeClient.getSessionStatusForDirectory("c:\\")).toEqual(status)
      expect(requests).toHaveLength(1)
      expect(requests[0].searchParams.get("directory")).toBe("C:/")
    } finally {
      fetch.mockRestore()
    }
  })
})
