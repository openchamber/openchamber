import { type CatalogKind } from "@/lib/opencode/events"
import { useGlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager } from "./child-store"
import { emitSyncConfigChanged } from "./sync-refs"
import { opencodeClient } from "@/lib/opencode/client"
import { spaceFoldersOfProject } from "./space-catalog-sync"
import { markConfigCatalogStale } from "@/stores/useConfigStore"
import { refreshStoresForCatalogKinds } from "@/stores/catalogRefresh"
import { getRuntimeKey } from "@/lib/runtime-switch"

type CatalogRuntime = { key: string; sdk: ReturnType<typeof opencodeClient.getSdkClient> }

export const isCatalogRuntimeCurrent = (runtime: CatalogRuntime): boolean =>
  runtime.key === getRuntimeKey() && runtime.sdk === opencodeClient.getSdkClient()

async function reloadCatalog(
  kind: CatalogKind,
  childStores: ChildStoreManager,
  eventDirectories: readonly string[],
  runtime: CatalogRuntime,
): Promise<void> {
  if (!isCatalogRuntimeCurrent(runtime)) return
  if (kind === "config") opencodeClient.clearConfigCache()

  if (kind === "project") {
    const projects = await opencodeClient.listProjects().catch(() => null)
    if (isCatalogRuntimeCurrent(runtime) && projects) {
      useGlobalSyncStore.getState().actions.set({ projects })
    }
    return
  }
  if (kind !== "config") return

  await Promise.all(eventDirectories.map(async (directory) => {
    const store = childStores.getChild(directory)
    if (!store) return
    if (!isCatalogRuntimeCurrent(runtime)) return
    try {
      const config = await opencodeClient.getConfig(directory)
      if (!isCatalogRuntimeCurrent(runtime)) return
      store.setState({ config })
      emitSyncConfigChanged(directory, config)
    } catch {
      // Best-effort: the next catalog event or bootstrap re-reads it.
    }
  }))
}

const CATALOG_RELOAD_DEBOUNCE_MS = 250

const pendingCatalogReloads = new Map<CatalogKind, Set<string>>()

const pendingCatalogCurrentKinds = new Set<CatalogKind>()

let pendingCatalogRuntime: CatalogRuntime | null = null

let catalogReloadTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleCatalogReload(
  kind: CatalogKind,
  childStores: ChildStoreManager,
  directory: string | null,
): void {
  const runtime = { key: getRuntimeKey(), sdk: opencodeClient.getSdkClient() }
  markConfigCatalogStale(kind, directory)
  if (directory) for (const spaceFolder of spaceFoldersOfProject(directory)) markConfigCatalogStale(kind, spaceFolder)
  if (pendingCatalogRuntime && !isCatalogRuntimeCurrent(pendingCatalogRuntime)) {
    pendingCatalogReloads.clear()
    pendingCatalogCurrentKinds.clear()
  }
  pendingCatalogRuntime = runtime
  const directories = pendingCatalogReloads.get(kind) ?? new Set<string>()
  if (directory) directories.add(directory)
  else pendingCatalogCurrentKinds.add(kind)
  pendingCatalogReloads.set(kind, directories)
  if (catalogReloadTimer) clearTimeout(catalogReloadTimer)
  catalogReloadTimer = setTimeout(() => {
    catalogReloadTimer = null
    const scheduledRuntime = pendingCatalogRuntime
    pendingCatalogRuntime = null
    const reloads = [...pendingCatalogReloads.entries()]
    const currentKinds = new Set(pendingCatalogCurrentKinds)
    pendingCatalogReloads.clear()
    pendingCatalogCurrentKinds.clear()
    if (!scheduledRuntime || !isCatalogRuntimeCurrent(scheduledRuntime)) return
    const currentDirectory = opencodeClient.getDirectory()
    for (const [pendingKind, pendingDirectories] of reloads) {
      if (currentKinds.has(pendingKind) && currentDirectory) pendingDirectories.add(currentDirectory)
      void reloadCatalog(pendingKind, childStores, [...pendingDirectories], scheduledRuntime)
    }
    void refreshStoresForCatalogKinds(new Map([...reloads].map(([kind, directories]) => [kind, [...directories]])))
  }, CATALOG_RELOAD_DEBOUNCE_MS)
}
