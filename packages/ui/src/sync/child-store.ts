import { create, type StoreApi } from "zustand"
import type { DirState, State } from "./types"
import { INITIAL_STATE, MAX_DIR_STORES, DIR_IDLE_TTL_MS } from "./types"
import { pickDirectoriesToEvict, canDisposeDirectory } from "./eviction"
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
  readonly children = new Map<string, StoreApi<DirectoryStore>>()
  private readonly lifecycle = new Map<string, DirState>()
  private readonly pins = new Map<string, number>()
  private readonly disposers = new Map<string, () => void>()

  private onBootstrap?: (directory: string) => void
  private onDispose?: (directory: string) => void
  private isBooting?: (directory: string) => boolean
  private isLoadingSessions?: (directory: string) => boolean

  configure(callbacks: {
    onBootstrap?: (directory: string) => void
    onDispose?: (directory: string) => void
    isBooting?: (directory: string) => boolean
    isLoadingSessions?: (directory: string) => boolean
  }) {
    this.onBootstrap = callbacks.onBootstrap
    this.onDispose = callbacks.onDispose
    this.isBooting = callbacks.isBooting
    this.isLoadingSessions = callbacks.isLoadingSessions
  }

  mark(directory: string) {
    if (!directory) return
    this.lifecycle.set(directory, { lastAccessAt: Date.now() })
    this.runEviction(directory)
  }

  pin(directory: string) {
    if (!directory) return
    this.pins.set(directory, (this.pins.get(directory) ?? 0) + 1)
    this.mark(directory)
  }

  unpin(directory: string) {
    if (!directory) return
    const next = (this.pins.get(directory) ?? 0) - 1
    if (next > 0) {
      this.pins.set(directory, next)
      return
    }
    this.pins.delete(directory)
    this.runEviction()
  }

  pinned(directory: string) {
    return (this.pins.get(directory) ?? 0) > 0
  }

  ensureChild(directory: string, options?: { bootstrap?: boolean }): StoreApi<DirectoryStore> {
    if (!directory) throw new Error("No directory provided to ensureChild")

    let store = this.children.get(directory)
    if (!store) {
      store = createDirectoryStore(directory)
      this.children.set(directory, store)
    }

    this.mark(directory)

    const shouldBootstrap = options?.bootstrap ?? true
    if (shouldBootstrap && store.getState().status === "loading") {
      this.onBootstrap?.(directory)
    }

    return store
  }

  getChild(directory: string): StoreApi<DirectoryStore> | undefined {
    return this.children.get(directory)
  }

  disposeDirectory(directory: string): boolean {
    if (
      !canDisposeDirectory({
        directory,
        hasStore: this.children.has(directory),
        pinned: this.pinned(directory),
        booting: this.isBooting?.(directory) ?? false,
        loadingSessions: this.isLoadingSessions?.(directory) ?? false,
      })
    ) {
      return false
    }

    this.lifecycle.delete(directory)
    this.children.delete(directory)
    const dispose = this.disposers.get(directory)
    if (dispose) {
      dispose()
      this.disposers.delete(directory)
    }
    this.onDispose?.(directory)
    return true
  }

  runEviction(skip?: string) {
    const stores = [...this.children.keys()]
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: this.lifecycle,
      pins: new Set(stores.filter((d) => this.pinned(d))),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: Date.now(),
    }).filter((d) => d !== skip)
    for (const directory of list) {
      this.disposeDirectory(directory)
    }
  }

  /** Apply a state mutation to a directory's store */
  update(directory: string, fn: (state: State) => Partial<State>) {
    const store = this.children.get(directory)
    if (!store) return
    const current = store.getState()
    const patch = fn(current)
    store.setState(patch)
  }

  /** Get current state of a directory store (snapshot) */
  getState(directory: string): State | undefined {
    return this.children.get(directory)?.getState()
  }

  disposeAll() {
    for (const directory of [...this.children.keys()]) {
      this.children.delete(directory)
    }
    this.lifecycle.clear()
    this.pins.clear()
    this.disposers.clear()
  }
}
