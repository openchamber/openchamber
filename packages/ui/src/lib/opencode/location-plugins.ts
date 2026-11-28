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
): Promise<"plugins" | "stateless" | "not-ready"> => withAbortDeadline(LIMIT_MS, async (signal) => {
  let checkStateless = isStateless
  let statelessProbe: Promise<boolean> | undefined
  const requestController = new AbortController()
  const abortRequests = () => requestController.abort()
  signal.addEventListener("abort", abortRequests, { once: true })
  try {
    while (!signal.aborted && isCurrent()) {
      const pluginRead = client.plugin.list(undefined, { signal: requestController.signal })
        .then((response) => response.data, () => null)
      const plugins = statelessProbe
        ? await Promise.race([pluginRead, statelessProbe.then<true | Awaited<typeof pluginRead>>((ready) => ready ? true : pluginRead)])
        : await pluginRead
      if (plugins === true) return !signal.aborted && isCurrent() ? "stateless" : "not-ready"
      if (plugins === null) {
        if (checkStateless || !isStateless) return "not-ready"
      } else {
        if (plugins.length > 0) return !signal.aborted && isCurrent() ? "plugins" : "not-ready"
        if (checkStateless && !signal.aborted && isCurrent()) {
          statelessProbe = checkStateless(requestController.signal).then((ready) => {
            if (!ready) statelessProbe = undefined
            return ready
          })
          checkStateless = undefined
        }
      }
      if (statelessProbe) {
        if (await Promise.race([statelessProbe, delay(POLL_MS).then(() => false)]))
          return !signal.aborted && isCurrent() ? "stateless" : "not-ready"
      } else await delay(POLL_MS)
    }
    return "not-ready"
  } finally {
    requestController.abort()
    signal.removeEventListener("abort", abortRequests)
  }
})

export const waitForLocationPlugins = async (client: Pick<OpenCodeClient, "plugin">, isCurrent?: () => boolean) =>
  await waitForLocation(client, isCurrent) === "plugins"

export const requireCatalogLocation = async (client: Pick<OpenCodeClient, "plugin" | "debug">, isCurrent?: () => boolean) => {
  const readiness = await waitForLocation(client, isCurrent, async (signal) => {
    const locations = await client.debug.location.list({ signal }).catch(() => null)
    return Array.isArray(locations) && locations.length === 0
  })
  if (readiness === "not-ready") throw new LocationPluginsNotReadyError()
  return readiness
}

export const requireModelCatalogLocations = async (clients: readonly Pick<OpenCodeClient, "plugin" | "debug">[], isCurrent: () => boolean) => {
  await Promise.all([...new Set(clients)].map((client) => requireCatalogLocation(client, isCurrent)))
}
