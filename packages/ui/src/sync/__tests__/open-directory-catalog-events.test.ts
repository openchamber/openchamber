import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import { opencodeClient } from "@/lib/opencode/client"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent, wakeDormantLocations } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useAgentsStore } from "@/stores/useAgentsStore"
import { useMcpStore } from "@/stores/useMcpStore"
import { useConfigStore } from "@/stores/useConfigStore"

// OpenCode announces a rebuilt catalog in the location it rebuilt it for. The
// project being worked in has a directory store, so its events take the
// directory branch; an agent file deleted or added there must still re-read the
// Settings agent list.

const agentUpdated: SyncEvent = { type: "catalog.updated", properties: { kind: "agent" } }
const configUpdated: SyncEvent = { type: "catalog.updated", properties: { kind: "config" } }
const CATALOG_SETTLE_MS = 400

describe("catalog events for an open directory", () => {
  let childStores: ChildStoreManager
  let agentLoads = 0
  let directoryAgentReads: Array<string | null | undefined> = []
  let directoryConfigReads: Array<string | null | undefined> = []
  const originalLoadAgents = useAgentsStore.getState().loadAgents
  const originalConfigLoadAgents = useConfigStore.getState().loadAgents
  const originalListAgents = opencodeClient.listAgents
  const originalGetConfig = opencodeClient.getConfig
  const originalDirectory = opencodeClient.getDirectory()

  beforeEach(() => {
    childStores = new ChildStoreManager()
    childStores.ensureChild("/open", { bootstrap: false })
    agentLoads = 0
    directoryAgentReads = []
    directoryConfigReads = []
    opencodeClient.setDirectory("/open")
    useConfigStore.setState({ loadAgents: async () => true })
    useAgentsStore.setState({
      loadAgents: async () => {
        agentLoads += 1
        return true
      },
    })
    opencodeClient.listAgents = async (directory) => {
      directoryAgentReads.push(directory)
      return []
    }
    opencodeClient.getConfig = async (directory) => {
      directoryConfigReads.push(directory)
      return {}
    }
  })

  afterEach(() => {
    childStores.disposeAll()
    useAgentsStore.setState({ loadAgents: originalLoadAgents })
    useConfigStore.setState({ loadAgents: originalConfigLoadAgents })
    opencodeClient.listAgents = originalListAgents
    opencodeClient.getConfig = originalGetConfig
    opencodeClient.setDirectory(originalDirectory)
  })

  test("agent.updated in the open directory re-reads the agents list", async () => {
    handleEvent("/open", agentUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(agentLoads).toBe(1)
    // The agents store owns the list; no directory store keeps a copy.
    expect(directoryAgentReads).toEqual([])
  })

  test("agent.updated in a directory without a store re-reads it too", async () => {
    handleEvent("/far", agentUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(agentLoads).toBe(2)
  })

  // Reading a directory makes OpenCode start it, MCP servers included. The
  // first project to announce its catalog used to start every other one.
  test("re-reads only the directory the event names, not every store", async () => {
    childStores.ensureChild("/sidebar-project", { bootstrap: false })

    handleEvent("/open", configUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(directoryConfigReads).toEqual(["/open"])
  })

  test("an event without a location re-reads the current directory only", async () => {
    childStores.ensureChild("/sidebar-project", { bootstrap: false })
    opencodeClient.setDirectory("/open")

    handleEvent("global", configUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(directoryConfigReads).toEqual(["/open"])
  })
})

// OpenCode starts a location's MCP servers asynchronously, so a status read
// right after the location started says `pending`; the change announcement
// is what brings the panel to `connected`.
describe("MCP status announcements", () => {
  const mcpStatusChanged: SyncEvent = { type: "mcp.status.changed", properties: { server: "linear" } }
  const originalListMcpServers = opencodeClient.listMcpServers
  let childStores: ChildStoreManager
  let statusReads: Array<string | null | undefined> = []

  beforeEach(() => {
    childStores = new ChildStoreManager()
    childStores.ensureChild("/open", { bootstrap: false })
    statusReads = []
    opencodeClient.listMcpServers = async (directory) => {
      statusReads.push(directory)
      return [{ name: "linear", status: { status: "connected" } }]
    }
    useMcpStore.getState().resetForRuntimeSwitch()
  })

  afterEach(() => {
    childStores.disposeAll()
    opencodeClient.listMcpServers = originalListMcpServers
    useMcpStore.getState().resetForRuntimeSwitch()
  })

  test("re-reads a held status once the burst settles", async () => {
    useMcpStore.setState({ byDirectory: { "/open": { linear: { name: "linear", status: { status: "pending" } } } } })

    handleEvent("/open", mcpStatusChanged, childStores, createEventRoutingIndex(), getRuntimeKey())
    handleEvent("/open", mcpStatusChanged, childStores, createEventRoutingIndex(), getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(statusReads).toEqual(["/open"])
    expect(useMcpStore.getState().getStatusForDirectory("/open").linear?.status.status).toBe("connected")
  })

  test("leaves a directory nobody asked about alone", async () => {
    handleEvent("/open", mcpStatusChanged, childStores, createEventRoutingIndex(), getRuntimeKey())
    handleEvent("/far", mcpStatusChanged, childStores, createEventRoutingIndex(), getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(statusReads).toEqual([])
  })
})

// Leaving a chat releases its location after 30 s. OpenCode announces the
// shutdown, then a status change for each server it stops; re-reading the
// held status then started the chat again 0.4 s after it was released.
describe("MCP status when a location shuts down", () => {
  const shutdown: SyncEvent = { type: "location.shutdown", properties: {} }
  const mcpStatusChanged: SyncEvent = { type: "mcp.status.changed", properties: { server: "linear" } }
  const held = { linear: { name: "linear", status: { status: "connected" as const } } }
  const originalListMcpServers = opencodeClient.listMcpServers
  const originalDirectory = opencodeClient.getDirectory()
  let childStores: ChildStoreManager
  let statusReads: Array<string | null | undefined> = []
  let bootstraps: string[] = []

  beforeEach(() => {
    childStores = new ChildStoreManager()
    childStores.ensureChild("/open", { bootstrap: false })
    childStores.ensureChild("/left-chat", { bootstrap: false })
    childStores.configure({
      onBootstrap: ({ directory }) => {
        bootstraps.push(directory)
      },
    })
    opencodeClient.setDirectory("/open")
    statusReads = []
    bootstraps = []
    opencodeClient.listMcpServers = async (directory) => {
      statusReads.push(directory)
      return [{ name: "linear", status: { status: "connected" } }]
    }
    useMcpStore.getState().resetForRuntimeSwitch()
    useMcpStore.setState({
      byDirectory: { "/open": held, "/left-chat": held },
      refreshedAtKeys: { "/open": Date.now(), "/left-chat": Date.now() },
    })
  })

  afterEach(() => {
    childStores.disposeAll()
    opencodeClient.listMcpServers = originalListMcpServers
    opencodeClient.setDirectory(originalDirectory)
    useMcpStore.getState().resetForRuntimeSwitch()
  })

  test("a directory the user left is not started again by the stop announcements", async () => {
    const routing = createEventRoutingIndex()
    handleEvent("/left-chat", shutdown, childStores, routing, getRuntimeKey())
    handleEvent("/left-chat", mcpStatusChanged, childStores, routing, getRuntimeKey())
    handleEvent("/left-chat", mcpStatusChanged, childStores, routing, getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(statusReads).toEqual([])
    expect(useMcpStore.getState().byDirectory["/left-chat"]).toBeUndefined()
    expect(useMcpStore.getState().byDirectory["/open"]).toBe(held)
    expect(bootstraps).toEqual([])
  })

  test("a status change announced just before the shutdown is dropped with it", async () => {
    const routing = createEventRoutingIndex()
    handleEvent("/left-chat", mcpStatusChanged, childStores, routing, getRuntimeKey())
    handleEvent("/left-chat", shutdown, childStores, routing, getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(statusReads).toEqual([])
  })

  test("a status read still in flight at the shutdown does not hold the status again", async () => {
    let answer = (): void => {}
    opencodeClient.listMcpServers = async (directory) => {
      statusReads.push(directory)
      await new Promise<void>((resolve) => { answer = resolve })
      return [{ name: "linear", status: { status: "connected" } }]
    }
    const routing = createEventRoutingIndex()
    handleEvent("/left-chat", mcpStatusChanged, childStores, routing, getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))
    expect(statusReads).toEqual(["/left-chat"])

    handleEvent("/left-chat", shutdown, childStores, routing, getRuntimeKey())
    answer()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useMcpStore.getState().byDirectory["/left-chat"]).toBeUndefined()

    handleEvent("/left-chat", mcpStatusChanged, childStores, routing, getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))
    expect(statusReads).toEqual(["/left-chat"])
  })

  test("returning to the directory reads its status afresh", async () => {
    handleEvent("/left-chat", shutdown, childStores, createEventRoutingIndex(), getRuntimeKey())

    await useMcpStore.getState().ensureFresh({ directory: "/left-chat", silent: true, maxAgeMs: 60_000 })

    expect(statusReads).toEqual(["/left-chat"])
  })

  test("the directory on screen keeps its status and is read again", async () => {
    const routing = createEventRoutingIndex()
    handleEvent("/open", shutdown, childStores, routing, getRuntimeKey())
    handleEvent("/open", mcpStatusChanged, childStores, routing, getRuntimeKey())
    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(bootstraps).toEqual(["/open"])
    expect(statusReads).toEqual(["/open"])
  })

  // An app left open overnight restarted the directory on screen, MCP servers
  // included, right after every hourly idle shutdown.
  describe("with the window hidden or unfocused", () => {
    const setUi = (visibilityState: "visible" | "hidden", focused: boolean) => {
      Object.defineProperty(globalThis, "document", {
        value: { visibilityState, hasFocus: () => focused },
        configurable: true,
      })
    }

    afterEach(() => {
      Reflect.deleteProperty(globalThis, "document")
      // The dormant set is module state; empty it for the next test.
      wakeDormantLocations(childStores, null)
    })

    const away = [
      { label: "hidden", visibility: "hidden", focused: false },
      { label: "visible but unfocused", visibility: "visible", focused: false },
    ] as const
    for (const { label, visibility, focused } of away) test(`the directory on screen waits while the window is ${label}`, async () => {
      setUi(visibility, focused)
      const routing = createEventRoutingIndex()
      handleEvent("/open", mcpStatusChanged, childStores, routing, getRuntimeKey())
      handleEvent("/open", shutdown, childStores, routing, getRuntimeKey())
      handleEvent("/open", mcpStatusChanged, childStores, routing, getRuntimeKey())
      await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

      expect(bootstraps).toEqual([])
      expect(statusReads).toEqual([])
      expect(useMcpStore.getState().byDirectory["/open"]).toBe(held)
    })

    test("coming back bootstraps it and reads its status once", async () => {
      setUi("hidden", false)
      handleEvent("/open", shutdown, childStores, createEventRoutingIndex(), getRuntimeKey())

      setUi("visible", true)
      wakeDormantLocations(childStores, "/open")
      wakeDormantLocations(childStores, "/open")
      await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

      expect(bootstraps).toEqual(["/open"])
      expect(statusReads).toEqual(["/open"])
    })

    test("a directory left while away is forgotten on return instead", async () => {
      setUi("hidden", false)
      handleEvent("/open", shutdown, childStores, createEventRoutingIndex(), getRuntimeKey())

      wakeDormantLocations(childStores, "/left-chat")
      await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

      expect(bootstraps).toEqual([])
      expect(statusReads).toEqual([])
      expect(useMcpStore.getState().byDirectory["/open"]).toBeUndefined()
    })

    test("a shutdown while focused bootstraps at once and leaves nothing to wake", async () => {
      setUi("hidden", false)
      const routing = createEventRoutingIndex()
      handleEvent("/open", shutdown, childStores, routing, getRuntimeKey())
      setUi("visible", true)
      handleEvent("/open", shutdown, childStores, routing, getRuntimeKey())
      wakeDormantLocations(childStores, "/open")

      expect(bootstraps).toEqual(["/open"])
    })
  })
})
