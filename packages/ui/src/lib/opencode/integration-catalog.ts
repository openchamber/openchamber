/**
 * OpenCode's integration list (`GET /api/integration`), kept for the app
 * session so Settings → Providers opens on it instead of waiting for the read.
 *
 * The list is what a user can connect and how each provider is connected
 * right now. The cached snapshot is a starting point only: Settings reads the
 * list again every time it opens, after every credential write, and when
 * OpenCode reports a credential change made elsewhere (an account switch after
 * a usage limit, another client, OpenCode's own TUI), and each read replaces
 * the snapshot. Nothing reads it while Settings is closed.
 *
 * The snapshot belongs to the runtime it was read from; after a runtime
 * switch it is ignored until a read from the new runtime lands.
 */

import type { IntegrationInfo } from "@opencode/client"
import { getRuntimeKey } from "../runtime-switch"
import { normalizeOpencodeError, opencodeClient, type OpenCodeClient } from "./client"
import { listWebSearchProviders } from "./websearch"

export interface IntegrationCatalog {
  integrations: IntegrationInfo[]
  /**
   * Web search providers are integrations too, but their keys live in
   * Settings → Web search. `null` when that list could not be read, so the
   * caller keeps them rather than hiding real providers.
   */
  webSearchIds: ReadonlySet<string> | null
}

let snapshot: { runtimeKey: string; catalog: IntegrationCatalog } | null = null
let latestRead = 0
let prefetching = false
const credentialChangeListeners = new Set<() => void>()

/** Called for OpenCode's `credential.updated` / `credential.switched` events. */
export function notifyCredentialChanged(): void {
  for (const listener of credentialChangeListeners) listener()
}

/** A screen showing the list re-reads it on a credential change; returns the unsubscribe. */
export function subscribeCredentialChanges(listener: () => void): () => void {
  credentialChangeListeners.add(listener)
  return () => {
    credentialChangeListeners.delete(listener)
  }
}

/** The last list read from the current runtime, or `null` when there is none. */
export function peekIntegrationCatalog(): IntegrationCatalog | null {
  return snapshot?.runtimeKey === getRuntimeKey() ? snapshot.catalog : null
}

/**
 * Reads the list again and keeps it. A read started earlier never replaces
 * one started later, so a read that began before a credential write cannot
 * bring back the state from before it. Throws when the integration list
 * cannot be read; a failed read is never an empty list.
 */
// Scoped like every location read: without a directory OpenCode answers for
// its own working directory, the home, and starts a location there.
const clientFor = (directory: string | null): OpenCodeClient =>
  directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()

/**
 * The client for the location the list is read from; credential writes
 * (`integration.connect.*`, `integration.oauth.*`) go there too. OpenCode
 * registers integrations per location once its plugins activate, and only the
 * list waits for that. A write sent to a location nobody read yet boots it and
 * is rejected with "Integration not found" until the plugins are up, so the
 * first try failed and the second worked.
 */
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

/**
 * Reads the list once when the current runtime has none yet. A failure is
 * left for Settings to report when it opens and reads the list itself.
 */
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
