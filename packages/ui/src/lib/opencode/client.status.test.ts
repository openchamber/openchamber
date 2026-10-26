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
  // The tray gates "Allow always" on these patterns, and the host seed is the
  // only source that reaches the index pre-parsed, so a strip here silently
  // turns a savable request into an unsavable one (#4698).
  test("the host status snapshot keeps the save patterns a pending permission carries", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      serverTime: 1_700_000_000_000,
      sessions: { s1: { status: "busy", lastUpdateAt: 1_700_000_000_000 } },
      pending: {
        s1: {
          permissions: [
            { id: "p-save", sessionID: "s1", action: "bash", resources: ["git status"], save: ["git *"] },
            { id: "p-once", sessionID: "s1", action: "bash", resources: ["rm -rf tmp"] },
          ],
          forms: [],
        },
      },
    }))
    try {
      const snapshot = await opencodeClient.getHostSessionStatusSnapshot()
      const permissions = snapshot?.pending?.s1?.permissions ?? []
      expect(permissions.map((p) => p.id)).toEqual(["p-save", "p-once"])
      expect(permissions[0]?.save).toEqual(["git *"])
      expect(permissions[1]?.save).toBeUndefined()
      // A host from before waiting pages sends no pages list; it reads as none.
      expect(snapshot?.pending?.s1?.pages).toEqual([])
    } finally {
      fetch.mockRestore()
    }
  })

  test("directory bootstrap blocking reads each spend one HTTP request", async () => {
    const requests: Array<{ path: string; directory: string | null }> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      requests.push({ path: url.pathname, directory: headers.get("x-opencode-directory") })
      return Response.json({ data: [] })
    })
    try {
      const options = { directories: ["C:/Tree with spaces"] }
      expect(await opencodeClient.listPendingForms(options)).toEqual([])
      expect(await opencodeClient.listPendingPermissions(options)).toEqual([])
      // Never a list without a directory: v2 answers it for its own working
      // directory and starts that location, MCP servers included.
      expect(requests).toEqual([
        { path: "/api/form", directory: encodeURIComponent("C:/Tree with spaces") },
        { path: "/api/permission/request", directory: encodeURIComponent("C:/Tree with spaces") },
      ])
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

  // #5087: images for a model without image input land in OpenCode's temp
  // folder on the machine OpenCode runs on, written through OpenCode itself.
  test("writes temp files into one new folder under OpenCode's temp folder and answers each path", async () => {
    const requests: Array<{ method: string; path: string; target: string | null; directory: string | null; type: string | null; size: number }> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init)
      const url = new URL(request.url)
      const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array()
      const target = url.searchParams.get("path")
      requests.push({
        method: request.method,
        path: url.pathname,
        target,
        directory: request.headers.get("x-opencode-directory"),
        type: request.headers.get("content-type"),
        size: body.length,
      })
      if (url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: 1, urls: [], paths: { tmp: "C:\\Temp\\opencode\\" } })
      if (target?.endsWith("broken.png")) return Response.json({ message: "disk full" }, { status: 400 })
      return Response.json({ location: { directory: "/repo" }, data: { path: target?.replace(/\\/g, "/") } })
    })
    try {
      const results = await opencodeClient.writeOpenCodeTempFiles("/repo", [
        { filename: "image-1.png", bytes: new Uint8Array([1, 2, 3]) },
        { filename: "broken.png", bytes: new Uint8Array([4]) },
        { filename: "image-2.png", bytes: new Uint8Array([5, 6]) },
      ])
      const [, first, second, third] = requests
      expect(requests[0]).toMatchObject({ method: "GET", path: "/api/info", directory: encodeURIComponent("/repo") })
      const folder = first.target?.slice(0, first.target.lastIndexOf("/"))
      expect(/^C:\\Temp\\opencode\/openchamber\/[0-9a-f]{16}$/.test(folder ?? "")).toBe(true)
      expect([first, second, third].map((request) => request.target)).toEqual([
        `${folder}/image-1.png`,
        `${folder}/broken.png`,
        `${folder}/image-2.png`,
      ])
      expect(first).toMatchObject({ method: "POST", path: "/api/experimental/fs/write", directory: encodeURIComponent("/repo"), type: "application/octet-stream", size: 3 })
      expect(results.map((result) => "path" in result ? result.path : `error:${result.filename}`)).toEqual([
        `${folder?.replace(/\\/g, "/")}/image-1.png`,
        "error:broken.png",
        `${folder?.replace(/\\/g, "/")}/image-2.png`,
      ])
    } finally {
      fetch.mockRestore()
    }
  })

  test("a failed temp-folder lookup writes nothing", async () => {
    const paths: string[] = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      paths.push(new URL(input instanceof Request ? input.url : input.toString()).pathname)
      return Response.json({ message: "down" }, { status: 503 })
    })
    try {
      await expect(opencodeClient.writeOpenCodeTempFiles("/repo", [{ filename: "image-1.png", bytes: new Uint8Array([1]) }])).rejects.toThrow()
      expect(paths).toEqual(["/api/info"])
    } finally {
      fetch.mockRestore()
    }
  })
})
