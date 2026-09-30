import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { SyncEvent } from "@/lib/opencode/events"
import { ChildStoreManager } from "../child-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useAgentsStore } from "@/stores/useAgentsStore"

// OpenCode announces a rebuilt catalog in the location it rebuilt it for. The
// project being worked in has a directory store, so its events take the
// directory branch; an agent file deleted or added there must still re-read the
// Settings agent list.

const agentUpdated: SyncEvent = { type: "catalog.updated", properties: { kind: "agent" } }
const CATALOG_SETTLE_MS = 400

describe("catalog events for an open directory", () => {
  let childStores: ChildStoreManager
  let agentLoads = 0
  const originalLoadAgents = useAgentsStore.getState().loadAgents

  beforeEach(() => {
    childStores = new ChildStoreManager()
    childStores.ensureChild("/open", { bootstrap: false })
    agentLoads = 0
    useAgentsStore.setState({
      loadAgents: async () => {
        agentLoads += 1
        return true
      },
    })
  })

  afterEach(() => {
    childStores.disposeAll()
    useAgentsStore.setState({ loadAgents: originalLoadAgents })
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
})
