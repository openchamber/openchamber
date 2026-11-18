import { ChildStoreManager } from "./child-store"
import { useMcpStore } from "@/stores/useMcpStore"

const MCP_STATUS_REFRESH_DEBOUNCE_MS = 250

const mcpStatusRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleMcpStatusRefresh(directory: string): void {
  if (dormantLocations.has(directory)) return
  const pending = mcpStatusRefreshTimers.get(directory)
  if (pending) clearTimeout(pending)
  mcpStatusRefreshTimers.set(directory, setTimeout(() => {
    mcpStatusRefreshTimers.delete(directory)
    void useMcpStore.getState().refreshIfHeld(directory)
  }, MCP_STATUS_REFRESH_DEBOUNCE_MS))
}

export function cancelMcpStatusRefresh(directory: string): void {
  const pending = mcpStatusRefreshTimers.get(directory)
  if (pending) clearTimeout(pending)
  mcpStatusRefreshTimers.delete(directory)
}

export function forgetMcpStatus(directory: string): void {
  cancelMcpStatusRefresh(directory)
  useMcpStore.getState().forgetDirectory(directory)
}

export const dormantLocations = new Set<string>()

export function wakeDormantLocations(childStores: ChildStoreManager, currentDirectory: string | null | undefined): void {
  for (const directory of dormantLocations) {
    if (directory !== currentDirectory) {
      forgetMcpStatus(directory)
      continue
    }
    if (childStores.getChild(directory)) {
      childStores.requestBootstrap({ directory, priority: "selected", reason: "location-shutdown", force: true })
    }
    void useMcpStore.getState().refreshIfHeld(directory)
  }
  dormantLocations.clear()
}
