import type { OpenCodeClient } from "@opencode/client"

import { delay } from "@/lib/timing/delay"
import { withAbortDeadline } from "@/lib/timing/withAbortDeadline"

// external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/cli/src/services/plugin-startup.ts Since 2.4.0 catalog reads on a cold location answer before its plugins load; plugin.list stays empty until the first activation ends.
const POLL_MS = 25
const LIMIT_MS = 5_000

class LocationPluginsNotReadyError extends Error {
  constructor() {
    super("OpenCode is still loading this folder's plugins")
    this.name = "LocationPluginsNotReadyError"
  }
}

const waitForLocation = (
  client: Pick<OpenCodeClient, "plugin">,
  isCurrent: () => boolean = () => true,
  isStateless?: (signal: AbortSignal) => Promise<boolean>,
): Promise<boolean> => withAbortDeadline(LIMIT_MS, async (signal) => {
  let checkStateless = isStateless
  while (!signal.aborted && isCurrent()) {
    let plugins
    try {
      plugins = (await client.plugin.list(undefined, { signal })).data
    } catch {
      return false
    }
    if (plugins.length > 0) return isCurrent()
    if (checkStateless && !signal.aborted && isCurrent()) {
      const stateless = await checkStateless(signal)
      if (stateless) return !signal.aborted && isCurrent()
      checkStateless = undefined
    }
    await delay(POLL_MS)
  }
  return false
})

export const waitForLocationPlugins = (client: Pick<OpenCodeClient, "plugin">, isCurrent?: () => boolean) =>
  waitForLocation(client, isCurrent)

const requireReadyLocations = async (checks: readonly Promise<boolean>[]) => {
  const ready = await Promise.all(checks)
  if (ready.includes(false)) throw new LocationPluginsNotReadyError()
}

export const requireLocationPlugins = (clients: readonly Pick<OpenCodeClient, "plugin">[], isCurrent?: () => boolean) =>
  requireReadyLocations([...new Set(clients)].map((client) => waitForLocationPlugins(client, isCurrent)))

export const requireModelCatalogLocations = (clients: readonly Pick<OpenCodeClient, "plugin" | "debug">[], isCurrent: () => boolean) =>
  requireReadyLocations([...new Set(clients)].map((client) => waitForLocation(client, isCurrent, async (signal) => {
    const locations = await client.debug.location.list({ signal }).catch(() => null)
    return Array.isArray(locations) && locations.length === 0
  })))
