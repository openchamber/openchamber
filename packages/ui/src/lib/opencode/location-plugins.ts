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

export const waitForLocationPlugins = (
  client: Pick<OpenCodeClient, "plugin">,
  isCurrent: () => boolean = () => true,
): Promise<boolean> => withAbortDeadline(LIMIT_MS, async (signal) => {
  while (!signal.aborted && isCurrent()) {
    let plugins
    try {
      plugins = (await client.plugin.list(undefined, { signal })).data
    } catch {
      return false
    }
    if (plugins.length > 0) return isCurrent()
    await delay(POLL_MS)
  }
  return false
})

export const requireLocationPlugins = async (clients: readonly Pick<OpenCodeClient, "plugin">[], isCurrent?: () => boolean) => {
  const ready = await Promise.all([...new Set(clients)].map((client) => waitForLocationPlugins(client, isCurrent)))
  if (ready.includes(false)) throw new LocationPluginsNotReadyError()
}
