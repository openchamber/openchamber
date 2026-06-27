import { describe, expect, test, beforeEach, mock } from "bun:test"
import {
  useServerStore,
  type ServerInfo,
} from "./server-context"

const sampleServer: ServerInfo = { id: "s1", label: "S1", type: "remote-url", status: "connecting", url: "http://s1" }

beforeEach(() => {
  useServerStore.setState({ servers: [], status: "idle" })
})

describe("fetchServerList", () => {
  test("fetches from /api/servers", async () => {
    const mocked = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([sampleServer]),
      })
    )
    ;(globalThis as Record<string, unknown>).fetch = mocked

    const { fetchServerList } = await import("./server-context")
    const servers = await fetchServerList()
    expect(servers[0].id).toBe("s1")
    expect(servers[0].label).toBe("S1")
  })

  test("throws on non-ok response", async () => {
    ;(globalThis as Record<string, unknown>).fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500 })
    )

    const { fetchServerList } = await import("./server-context")
    let threw = false
    try { await fetchServerList() } catch { threw = true }
    expect(threw).toBe(true)
  })
})

describe("useServerStore", () => {
  test("returns empty array initially", () => {
    useServerStore.setState({ servers: [], status: "idle" })
    expect(useServerStore.getState().servers).toEqual([])
  })

  test("upsertServer adds new server", () => {
    useServerStore.setState({ servers: [], status: "ready" })
    useServerStore.getState().upsertServer(sampleServer)
    expect(useServerStore.getState().servers).toEqual([sampleServer])
  })

  test("upsertServer updates existing server", () => {
    useServerStore.setState({ servers: [sampleServer], status: "ready" })
    useServerStore.getState().upsertServer({ ...sampleServer, status: "connected" })
    expect(useServerStore.getState().servers[0].status).toBe("connected")
  })

  test("setServers replaces entire list", () => {
    useServerStore.setState({ servers: [], status: "ready" })
    useServerStore.getState().setServers([
      { id: "a", label: "A", type: "local", status: "connected", url: "" },
      { id: "b", label: "B", type: "remote-url", status: "disconnected", url: "http://b" },
    ])
    expect(useServerStore.getState().servers.length).toBe(2)
    expect(useServerStore.getState().status).toBe("ready")
  })
})

describe("registerServer", () => {
  test("posts to /api/servers and returns server info", async () => {
    ;(globalThis as Record<string, unknown>).fetch = mock((url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {}
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...body, status: "connected" }),
      })
    })

    const { registerServer } = await import("./server-context")
    const result = await registerServer({ id: "r1", label: "R1", type: "remote-url", url: "http://r1" })
    expect(result.id).toBe("r1")
    expect(result.status).toBe("connected")
  })

  test("throws on non-ok response", async () => {
    ;(globalThis as Record<string, unknown>).fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid config" }),
      })
    )

    const { registerServer } = await import("./server-context")
    let threw = false
    try { await registerServer({ id: "bad", label: "Bad", type: "remote-url", url: "http://bad" }) } catch { threw = true }
    expect(threw).toBe(true)
  })
})

describe("unregisterServer", () => {
  test("fetches DELETE /api/servers/:id", async () => {
    let called = false
    ;(globalThis as Record<string, unknown>).fetch = mock(() => {
      called = true
      return Promise.resolve({ ok: true })
    })

    const { unregisterServer } = await import("./server-context")
    await unregisterServer("to-delete")
    expect(called).toBe(true)
  })
})
