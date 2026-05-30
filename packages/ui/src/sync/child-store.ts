import { create, type StoreApi } from "zustand"
import type { DirState, State } from "./types"
import { INITIAL_STATE, MAX_DIR_STORES, DIR_IDLE_TTL_MS } from "./types"
import { pickDirectoriesToEvict, canDisposeDirectory, hasPendingBlockingRequests } from "./eviction"
import { readDirCache, persistVcs, persistProjectMeta, persistIcon } from "./persist-cache"

export type DirectoryStore = State & {
  /** Apply a partial state update */
  patch: (partial: Partial<State>) => void
  /** Replace state wholesale (used during bootstrap) */
  replace: (next: State) => void
}

function createDirectoryStore(directory: string): StoreApi<DirectoryStore> {
  // Restore cached metadata from localStorage
  const cached = readDirCache(directory)

  const store = create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    vcs: cached.vcs ?? INITIAL_STATE.vcs,
    projectMeta: cached.projectMeta ?? INITIAL_STATE.projectMeta,
    icon: cached.icon ?? INITIAL_STATE.icon,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))

  // Subscribe to persist metadata changes back to localStorage
  store.subscribe((state, prev) => {
    if (state.vcs !== prev.vcs) persistVcs(directory, state.vcs)
    if (state.projectMeta !== prev.projectMeta) persistProjectMeta(directory, state.projectMeta)
    if (state.icon !== prev.icon) persistIcon(directory, state.icon)
  })

  return store
}

export class ChildStoreManager {
  readonly children = new Map<string, Map<string, StoreApi<DirectoryStore>>>()
  private readonly lifecycle = new Map<string, DirState>()
  private readonly pins = new Map<string, number>()
  private readonly disposers = new Map<string, () => void>()
  private readonly registrySubscribers = new Set<() => void>()

  private onBootstrap?: (directory: string, serverId: string) => void
  private onDispose?: (directory: string) => void
  private isBooting?: (directory: string) => boolean
  private isLoadingSessions?: (directory: string) => boolean

  private key(serverId: string, directory: string): string {
    return `${serverId}::${directory}`
  }

  private splitKey(key: string): { serverId: string; directory: string } {
    const idx = key.indexOf("::")
    if (idx === -1) return { serverId: "local", directory: key }
    return { serverId: key.slice(0, idx), directory: key.slice(idx + 2) }
  }

  private notifyRegistrySubscribers() {
    for (const subscriber of this.registrySubscribers) {
      subscriber()
    }
  }

  configure(callbacks: {
    onBootstrap?: (directory: string, serverId: string) => void
    onDispose?: (directory: string) => void
    isBooting?: (directory: string) => boolean
    isLoadingSessions?: (directory: string) => boolean
  }) {
    this.onBootstrap = callbacks.onBootstrap
    this.onDispose = callbacks.onDispose
    this.isBooting = callbacks.isBooting
    this.isLoadingSessions = callbacks.isLoadingSessions
  }

  mark(serverId: string, directory: string) {
    if (!directory) return
    const k = this.key(serverId, directory)
    this.lifecycle.set(k, { lastAccessAt: Date.now() })
    this.runEviction(k)
  }

  pin(serverId: string, directory: string) {
    if (!directory) return
    const k = this.key(serverId, directory)
    this.pins.set(k, (this.pins.get(k) ?? 0) + 1)
    this.mark(serverId, directory)
  }

  unpin(serverId: string, directory: string) {
    if (!directory) return
    const k = this.key(serverId, directory)
    const next = (this.pins.get(k) ?? 0) - 1
    if (next > 0) {
      this.pins.set(k, next)
      return
    }
    this.pins.delete(k)
    this.runEviction()
  }

  pinned(serverId: string, directory: string) {
    const k = this.key(serverId, directory)
    return (this.pins.get(k) ?? 0) > 0
  }

  ensureChild(directory: string, options?: { bootstrap?: boolean }): StoreApi<DirectoryStore> {
    return this.getOrCreateChildStore("local", directory, options)
  }

  getOrCreateChildStore(serverId: string, directory: string, options?: { bootstrap?: boolean }): StoreApi<DirectoryStore> {
    if (!directory) throw new Error("No directory provided to getOrCreateChildStore")

    let serverMap = this.children.get(serverId)
    if (!serverMap) {
      serverMap = new Map()
      this.children.set(serverId, serverMap)
    }

    let store = serverMap.get(directory)
    if (!store) {
      store = createDirectoryStore(directory)
      serverMap.set(directory, store)
      this.notifyRegistrySubscribers()
    }

    this.mark(serverId, directory)

    const shouldBootstrap = options?.bootstrap ?? true
    if (shouldBootstrap && store.getState().status === "loading") {
      this.onBootstrap?.(directory, serverId)
    }

    return store
  }

  getChild(directory: string): StoreApi<DirectoryStore> | undefined {
    return this.getChildByServer("local", directory)
  }

  getChildByServer(serverId: string, directory: string): StoreApi<DirectoryStore> | undefined {
    return this.children.get(serverId)?.get(directory)
  }

  /**
   * Find a child store by directory across all servers.
   * Returns the first match.
   */
  findChildByDirectory(directory: string): StoreApi<DirectoryStore> | undefined {
    for (const serverMap of this.children.values()) {
      const store = serverMap.get(directory)
      if (store) return store
    }
    return undefined
  }

  getAllStores(): StoreApi<DirectoryStore>[] {
    const result: StoreApi<DirectoryStore>[] = []
    for (const serverMap of this.children.values()) {
      for (const store of serverMap.values()) {
        result.push(store)
      }
    }
    return result
  }

  getAllEntries(): Array<{ serverId: string; directory: string; store: StoreApi<DirectoryStore> }> {
    const result: Array<{ serverId: string; directory: string; store: StoreApi<DirectoryStore> }> = []
    for (const [serverId, serverMap] of this.children.entries()) {
      for (const [directory, store] of serverMap.entries()) {
        result.push({ serverId, directory, store })
      }
    }
    return result
  }

  getServerIds(): string[] {
    return [...this.children.keys()]
  }

  removeAllForServer(serverId: string) {
    const serverMap = this.children.get(serverId)
    if (!serverMap) return
    for (const directory of serverMap.keys()) {
      const k = this.key(serverId, directory)
      this.lifecycle.delete(k)
      this.pins.delete(k)
      const dispose = this.disposers.get(k)
      if (dispose) {
        dispose()
        this.disposers.delete(k)
      }
      this.onDispose?.(directory)
    }
    serverMap.clear()
    this.children.delete(serverId)
    this.notifyRegistrySubscribers()
  }

  disposeDirectory(directory: string): boolean {
    return this.disposeDirectoryForServer("local", directory)
  }

  disposeDirectoryForServer(serverId: string, directory: string): boolean {
    const k = this.key(serverId, directory)
    const serverMap = this.children.get(serverId)
    const hasStore = serverMap?.has(directory) ?? false

    if (
      !canDisposeDirectory({
        directory,
        hasStore,
        pinned: this.pinned(serverId, directory),
        booting: this.isBooting?.(directory) ?? false,
        loadingSessions: this.isLoadingSessions?.(directory) ?? false,
        hasPendingBlockingRequests: this.hasPendingBlockingRequestsForServerDirectory(serverId, directory),
      })
    ) {
      return false
    }

    this.lifecycle.delete(k)
    serverMap?.delete(directory)
    if (serverMap && serverMap.size === 0) {
      this.children.delete(serverId)
    }
    this.notifyRegistrySubscribers()
    const dispose = this.disposers.get(k)
    if (dispose) {
      dispose()
      this.disposers.delete(k)
    }
    this.onDispose?.(directory)
    return true
  }

  runEviction(skipKey?: string) {
    const allKeys: string[] = []
    for (const [serverId, serverMap] of this.children.entries()) {
      for (const directory of serverMap.keys()) {
        allKeys.push(this.key(serverId, directory))
      }
    }
    if (allKeys.length === 0) return
    const list = pickDirectoriesToEvict({
      stores: allKeys,
      state: this.lifecycle,
      pins: new Set(allKeys.filter((k) => (this.pins.get(k) ?? 0) > 0)),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: Date.now(),
      hasPendingBlockingRequests: (k) => {
        const { serverId, directory } = this.splitKey(k)
        return this.hasPendingBlockingRequestsForServerDirectory(serverId, directory)
      },
    }).filter((d) => d !== skipKey)
    for (const key of list) {
      const { serverId, directory } = this.splitKey(key)
      this.disposeDirectoryForServer(serverId, directory)
    }
  }

  hasPendingBlockingRequestsForDirectory(directory: string): boolean {
    return this.hasPendingBlockingRequestsForServerDirectory("local", directory)
  }

  hasPendingBlockingRequestsForServerDirectory(serverId: string, directory: string): boolean {
    return hasPendingBlockingRequests(this.children.get(serverId)?.get(directory)?.getState())
  }

  update(directory: string, fn: (state: State) => Partial<State>) {
    this.updateByServer("local", directory, fn)
  }

  updateByServer(serverId: string, directory: string, fn: (state: State) => Partial<State>) {
    const store = this.children.get(serverId)?.get(directory)
    if (!store) return
    const current = store.getState()
    const patch = fn(current)
    store.setState(patch)
  }

  getState(directory: string): State | undefined {
    return this.getStateByServer("local", directory)
  }

  getStateByServer(serverId: string, directory: string): State | undefined {
    return this.children.get(serverId)?.get(directory)?.getState()
  }

  disposeAll() {
    for (const dispose of this.disposers.values()) {
      try { dispose() } catch { /* ignore */ }
    }
    for (const serverMap of this.children.values()) {
      serverMap.clear()
    }
    this.children.clear()
    this.notifyRegistrySubscribers()
    this.lifecycle.clear()
    this.pins.clear()
    this.disposers.clear()
  }

  subscribeRegistry(listener: () => void): () => void {
    this.registrySubscribers.add(listener)
    return () => {
      this.registrySubscribers.delete(listener)
    }
  }

  subscribeAll(listener: () => void): () => void {
    const storeUnsubscribers = new Map<StoreApi<DirectoryStore>, () => void>()

    const syncStoreSubscriptions = () => {
      const activeStores = new Set(this.getAllStores())

      for (const [store, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeStores.has(store)) {
          continue
        }
        unsubscribe()
        storeUnsubscribers.delete(store)
      }

      for (const store of activeStores) {
        if (storeUnsubscribers.has(store)) {
          continue
        }
        storeUnsubscribers.set(store, store.subscribe(listener))
      }
    }

    syncStoreSubscriptions()
    const unsubscribeRegistry = this.subscribeRegistry(() => {
      syncStoreSubscriptions()
      listener()
    })

    return () => {
      unsubscribeRegistry()
      for (const unsubscribe of storeUnsubscribers.values()) {
        unsubscribe()
      }
      storeUnsubscribers.clear()
    }
  }
}
