
import type { IntegrationInfo } from "@opencode/client"
import { getRuntimeKey } from "../runtime-switch"
import { normalizeOpencodeError, opencodeClient, type OpenCodeClient } from "./client"
import { listWebSearchProviders } from "./websearch"

export interface IntegrationCatalog {
  integrations: IntegrationInfo[]
  webSearchIds: ReadonlySet<string> | null
}

let snapshot: { runtimeKey: string; catalog: IntegrationCatalog } | null = null
let latestRead = 0
let prefetching = false
const credentialChangeListeners = new Set<() => void>()

export function notifyCredentialChanged(): void {
  for (const listener of credentialChangeListeners) listener()
}

export function subscribeCredentialChanges(listener: () => void): () => void {
  credentialChangeListeners.add(listener)
  return () => {
    credentialChangeListeners.delete(listener)
  }
}

export function peekIntegrationCatalog(): IntegrationCatalog | null {
  return snapshot?.runtimeKey === getRuntimeKey() ? snapshot.catalog : null
}

const clientFor = (directory: string | null): OpenCodeClient =>
  directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()

// external: https://github.com/anomalyco/opencode/tree/v2.3.0/packages/core/src Integration reads wait for plugin activation; credential writes need the same warmed location.
export function getIntegrationClient(): OpenCodeClient {
  return clientFor(opencodeClient.getDirectory() || null)
}

async function readIntegrations(directory: string | null): Promise<IntegrationInfo[]> {
  try {
    const response = await clientFor(directory).integration.list()
    return response.data
  } catch (error) {
    throw normalizeOpencodeError("integration.list", error)
  }
}

export async function loadIntegrationCatalog(): Promise<IntegrationCatalog> {
  const runtimeKey = getRuntimeKey()
  const read = ++latestRead
  const directory = opencodeClient.getDirectory() || null
  const [integrations, webSearchProviders] = await Promise.all([
    readIntegrations(directory),
    listWebSearchProviders(directory).catch(() => null),
  ])
  const catalog: IntegrationCatalog = {
    integrations,
    webSearchIds: webSearchProviders ? new Set(webSearchProviders.map((provider) => provider.id)) : null,
  }
  if (read === latestRead && runtimeKey === getRuntimeKey()) {
    snapshot = { runtimeKey, catalog }
  }
  return catalog
}

export function prefetchIntegrationCatalog(): void {
  if (prefetching || peekIntegrationCatalog()) return
  prefetching = true
  void (async () => {
    try {
      await loadIntegrationCatalog()
    } catch (error) {
      console.warn("[providers] could not prefetch the integration list:", error instanceof Error ? error.message : String(error))
    } finally {
      prefetching = false
    }
  })()
}
