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

describe("v2 status and cancellation HTTP boundary", () => {
  test("directory bootstrap blocking reads each spend one HTTP request", async () => {
    const requests: Array<{ path: string; directory: string | null }> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      requests.push({ path: url.pathname, directory: headers.get("x-opencode-directory") })
      return Response.json({ data: [] })
    })
    try {
      const options = { directories: ["C:/Tree with spaces"], includeGlobal: false }
      expect(await opencodeClient.listPendingForms(options)).toEqual([])
      expect(await opencodeClient.listPendingPermissions(options)).toEqual([])
      expect(requests).toEqual([
        { path: "/api/form", directory: encodeURIComponent("C:/Tree with spaces") },
        { path: "/api/permission/request", directory: encodeURIComponent("C:/Tree with spaces") },
      ])
      requests.length = 0
      await opencodeClient.listPendingForms({ directories: options.directories })
      expect(requests).toHaveLength(2)
      expect(requests[0].directory).toBeNull()
      expect(requests[1].directory).toBe(encodeURIComponent("C:/Tree with spaces"))
    } finally {
      fetch.mockRestore()
    }
  })

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
      const request = sdk.command.list(undefined, { signal: controller.signal })
      await ready
      controller.abort(reason)
      expect(await request.catch((error: Error) => error)).toMatchObject({ reason: "Transport", cause: reason })
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
      const request = sdk.command.list(undefined, { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort(reason)
      expect(await request.catch((error: Error) => error)).toMatchObject({ cause: reason })
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
      const error = await sdk.command.list().then(() => undefined, (failure: Error) => failure)
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
      for (const body of [null, [], { session: { type: "unknown" } }, { session: {} }, { "": { type: "running" } }]) {
        fetch.mockImplementation(async () => Response.json({ data: body }))
        expect(await opencodeClient.getActiveSessionStatuses()).toBeNull()
      }
      fetch.mockImplementation(async () => Response.json({ data: {} }))
      expect(await opencodeClient.getActiveSessionStatuses()).toEqual({})
    } finally {
      fetch.mockRestore()
    }
  })

  test("reads v2 activity globally even when the selected directory is a Windows root", async () => {
    const requests: URL[] = []
    const status = { session: { type: "running" } }
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString()))
      return Response.json({ data: status })
    })
    try {
      opencodeClient.setDirectory("c:\\")
      expect(await opencodeClient.getActiveSessionStatuses()).toEqual({ session: { type: "busy" } })
      expect(requests).toHaveLength(1)
      expect(requests[0].pathname).toBe("/api/session/active")
      expect(requests[0].searchParams.has("directory")).toBe(false)
    } finally {
      opencodeClient.setDirectory(undefined)
      fetch.mockRestore()
    }
  })
})
