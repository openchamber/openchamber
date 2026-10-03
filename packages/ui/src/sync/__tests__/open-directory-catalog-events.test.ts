import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import { opencodeClient } from "@/lib/opencode/client"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useAgentsStore } from "@/stores/useAgentsStore"
import { useMcpStore } from "@/stores/useMcpStore"

// OpenCode announces a rebuilt catalog in the location it rebuilt it for. The
// project being worked in has a directory store, so its events take the
// directory branch; an agent file deleted or added there must still re-read the
// Settings agent list.

const agentUpdated: SyncEvent = { type: "catalog.updated", properties: { kind: "agent" } }
const CATALOG_SETTLE_MS = 400

describe("catalog events for an open directory", () => {
  let childStores: ChildStoreManager
  let agentLoads = 0
  let directoryAgentReads: Array<string | null | undefined> = []
  const originalLoadAgents = useAgentsStore.getState().loadAgents
  const originalListAgents = opencodeClient.listAgents
  const originalDirectory = opencodeClient.getDirectory()

  beforeEach(() => {
    childStores = new ChildStoreManager()
    childStores.ensureChild("/open", { bootstrap: false })
    agentLoads = 0
    directoryAgentReads = []
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
  })

  afterEach(() => {
    childStores.disposeAll()
    useAgentsStore.setState({ loadAgents: originalLoadAgents })
    opencodeClient.listAgents = originalListAgents
    opencodeClient.setDirectory(originalDirectory)
  })

  test("agent.updated in the open directory re-reads the agents list", async () => {
    handleEvent("/open", agentUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(agentLoads).toBe(1)
  })

  test("agent.updated in a directory without a store re-reads it too", async () => {
    handleEvent("/far", agentUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(agentLoads).toBe(1)
  })

  // Reading a directory makes OpenCode start it, MCP servers included. The
  // first project to announce its catalog used to start every other one.
  test("re-reads only the directory the event names, not every store", async () => {
    childStores.ensureChild("/sidebar-project", { bootstrap: false })

    handleEvent("/open", agentUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(directoryAgentReads).toEqual(["/open"])
  })

  test("an event without a location re-reads the current directory only", async () => {
    childStores.ensureChild("/sidebar-project", { bootstrap: false })
    opencodeClient.setDirectory("/open")

    handleEvent("global", agentUpdated, childStores, createEventRoutingIndex(), getRuntimeKey())

    await new Promise((resolve) => setTimeout(resolve, CATALOG_SETTLE_MS))

    expect(directoryAgentReads).toEqual(["/open"])
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
