import { create, type StoreApi } from "zustand"
import type { DirState, State } from "./types"
import { INITIAL_STATE, MAX_DIR_STORES, DIR_IDLE_TTL_MS } from "./types"
import { pickDirectoriesToEvict, canDisposeDirectory, hasPendingBlockingRequests } from "./eviction"
import { readDirCache, persistVcs, persistProjectMeta, persistIcon, persistSessions } from "./persist-cache"
import { normalizePath } from "@/lib/pathNormalization"
import { startSessionLoadPerformanceEvent } from "./session-load-performance"

export type DirectoryStore = State & {
  /** Apply a partial state update */
  patch: (partial: Partial<State>) => void
  /** Replace state wholesale (used during bootstrap) */
  replace: (next: State) => void
}

export type DirectoryBootstrapPriority = "selected" | "active-project" | "expanded" | "visible" | "background"

export type DirectoryBootstrapReason =
  | "current-directory"
  | "selected-session"
  | "known-project"
  | "known-worktree"
  | "project-expanded"
  | "worktree-expanded"
  | "server-connected"
  | "action-demand"

export type DirectoryBootstrapDemand = {
  directory: string
  priority: DirectoryBootstrapPriority
  reason: DirectoryBootstrapReason
  force?: boolean
}

export type DirectoryBootstrapState = "queued" | "running" | "complete" | "failed"

export type DirectoryBootstrapContext = DirectoryBootstrapDemand & {
  generation: number
  isCurrent: () => boolean
}

const BOOTSTRAP_PRIORITY: Record<DirectoryBootstrapPriority, number> = {
  selected: 0,
  "active-project": 1,
  expanded: 2,
  visible: 3,
  background: 4,
}

type QueuedBootstrap = DirectoryBootstrapDemand & {
  sequence: number
  enqueuedAt: number
}

type RunningBootstrap = QueuedBootstrap & {
  generation: number
  token: object
  manualDemandRevision?: number
  rerunRequested?: boolean
}

type ManualBootstrapDemand = {
  demand: DirectoryBootstrapDemand
  revision: number
}

function createDirectoryStore(directory: string): StoreApi<DirectoryStore> {
  // Restore cached metadata from localStorage
  const cached = readDirCache(directory)

  // Stale-while-revalidate: seed the session list from cache so the sidebar
  // paints chats instantly. Bootstrap phase-3 loadSessions overwrites with the
  // fresh list (its empty-list race guard preserves these until then).
  const cachedSessions = cached.sessions ?? INITIAL_STATE.session

  const store = create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    vcs: cached.vcs ?? INITIAL_STATE.vcs,
    projectMeta: cached.projectMeta ?? INITIAL_STATE.projectMeta,
    icon: cached.icon ?? INITIAL_STATE.icon,
    session: cachedSessions,
    sessionTotal: cachedSessions.length,
    limit: Math.max(cachedSessions.length, INITIAL_STATE.limit),
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))

  // Subscribe to persist metadata changes back to localStorage
  store.subscribe((state, prev) => {
    if (state.vcs !== prev.vcs) persistVcs(directory, state.vcs)
    if (state.projectMeta !== prev.projectMeta) persistProjectMeta(directory, state.projectMeta)
    if (state.icon !== prev.icon) persistIcon(directory, state.icon)
    if (state.session !== prev.session) persistSessions(directory, state.session)
  })

  return store
}

export class ChildStoreManager {
  readonly children = new Map<string, StoreApi<DirectoryStore>>()
  private readonly lifecycle = new Map<string, DirState>()
  private readonly pins = new Map<string, number>()
  private readonly disposers = new Map<string, () => void>()
  private readonly registrySubscribers = new Set<() => void>()
  private readonly bootstrapSubscribers = new Set<() => void>()
  private readonly bootstrapDemandsByOwner = new Map<string, Map<string, DirectoryBootstrapDemand>>()
  private readonly manualBootstrapDemands = new Map<string, ManualBootstrapDemand>()
  private readonly bootstrapQueue = new Map<string, QueuedBootstrap>()
  private readonly runningBootstraps = new Map<string, RunningBootstrap>()
  private readonly bootstrapStates = new Map<string, DirectoryBootstrapState>()

  private onBootstrap?: (context: DirectoryBootstrapContext) => Promise<void> | void
  private onDispose?: (directory: string) => void
  private isBooting?: (directory: string) => boolean
  private isLoadingSessions?: (directory: string) => boolean
  private bootstrapConcurrency = 2
  private bootstrapGeneration = 0
  private bootstrapSequence = 0
  private manualBootstrapDemandRevision = 0
  private disposed = false

  private notifyRegistrySubscribers() {
    for (const subscriber of this.registrySubscribers) {
      subscriber()
    }
  }

  private notifyBootstrapSubscribers() {
    for (const subscriber of this.bootstrapSubscribers) subscriber()
  }

  configure(callbacks: {
    onBootstrap?: (context: DirectoryBootstrapContext) => Promise<void> | void
    onDispose?: (directory: string) => void
    isBooting?: (directory: string) => boolean
    isLoadingSessions?: (directory: string) => boolean
    bootstrapConcurrency?: number
  }): () => void {
    const generation = ++this.bootstrapGeneration
    this.disposed = false
    this.onBootstrap = callbacks.onBootstrap
    this.onDispose = callbacks.onDispose
    this.isBooting = callbacks.isBooting
    this.isLoadingSessions = callbacks.isLoadingSessions
    this.bootstrapConcurrency = Math.max(1, Math.floor(callbacks.bootstrapConcurrency ?? 2))
    this.pumpBootstrapQueue()

    return () => {
      if (this.bootstrapGeneration !== generation) return
      this.bootstrapGeneration += 1
      this.onBootstrap = undefined
      this.onDispose = undefined
      this.isBooting = undefined
      this.isLoadingSessions = undefined
    }
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

  ensureChild(
    directory: string,
    options?: {
      bootstrap?: boolean
      priority?: DirectoryBootstrapPriority
      reason?: DirectoryBootstrapReason
    },
  ): StoreApi<DirectoryStore> {
    const normalizedDirectory = normalizePath(directory)
    if (!normalizedDirectory) throw new Error("No directory provided to ensureChild")

    let store = this.children.get(normalizedDirectory)
    if (!store) {
      store = createDirectoryStore(normalizedDirectory)
      this.children.set(normalizedDirectory, store)
      this.notifyRegistrySubscribers()
    }

    this.mark(normalizedDirectory)

    const shouldBootstrap = options?.bootstrap ?? true
    if (shouldBootstrap && store.getState().status === "loading") {
      this.requestBootstrap({
        directory: normalizedDirectory,
        priority: options?.priority ?? "selected",
        reason: options?.reason ?? "action-demand",
      })
    }

    return store
  }

  getChild(directory: string): StoreApi<DirectoryStore> | undefined {
    const normalizedDirectory = normalizePath(directory)
    return normalizedDirectory ? this.children.get(normalizedDirectory) : undefined
  }

  requestBootstrap(demand: DirectoryBootstrapDemand): void {
    const normalizedDirectory = normalizePath(demand.directory)
    if (!normalizedDirectory || this.disposed) return
    const normalizedDemand = { ...demand, directory: normalizedDirectory }
    const existingDemand = this.manualBootstrapDemands.get(normalizedDirectory)?.demand
    const nextDemand = existingDemand
      ? {
          ...existingDemand,
          ...normalizedDemand,
          priority: BOOTSTRAP_PRIORITY[normalizedDemand.priority] < BOOTSTRAP_PRIORITY[existingDemand.priority]
            ? normalizedDemand.priority
            : existingDemand.priority,
          force: Boolean(existingDemand.force || normalizedDemand.force),
        }
      : normalizedDemand
    this.manualBootstrapDemands.set(normalizedDirectory, {
      demand: nextDemand,
      revision: ++this.manualBootstrapDemandRevision,
    })
    this.ensureChild(normalizedDirectory, { bootstrap: false })
    this.queueBootstrap(nextDemand)
  }

  setBootstrapDemand(owner: string, demands: DirectoryBootstrapDemand[]): void {
    if (!owner || this.disposed) return
    const next = new Map<string, DirectoryBootstrapDemand>()
    for (const demand of demands) {
      const directory = normalizePath(demand.directory)
      if (!directory) continue
      const normalized = { ...demand, directory }
      const existing = next.get(directory)
      if (!existing || BOOTSTRAP_PRIORITY[normalized.priority] < BOOTSTRAP_PRIORITY[existing.priority]) {
        next.set(directory, normalized)
      }
    }
    this.bootstrapDemandsByOwner.set(owner, next)
    this.reconcileBootstrapQueue()
  }

  clearBootstrapDemand(owner: string): void {
    if (!this.bootstrapDemandsByOwner.delete(owner)) return
    this.reconcileBootstrapQueue()
  }

  getBootstrapState(directory: string): DirectoryBootstrapState | undefined {
    const normalizedDirectory = normalizePath(directory)
    return normalizedDirectory ? this.bootstrapStates.get(normalizedDirectory) : undefined
  }

  subscribeBootstrap(listener: () => void): () => void {
    this.bootstrapSubscribers.add(listener)
    return () => this.bootstrapSubscribers.delete(listener)
  }

  private aggregateBootstrapDemand(directory: string): DirectoryBootstrapDemand | undefined {
    let result = this.manualBootstrapDemands.get(directory)?.demand
    for (const demands of this.bootstrapDemandsByOwner.values()) {
      const demand = demands.get(directory)
      if (!demand) continue
      if (!result || BOOTSTRAP_PRIORITY[demand.priority] < BOOTSTRAP_PRIORITY[result.priority]) result = demand
    }
    return result
  }

  private reconcileBootstrapQueue(): void {
    const directories = new Set<string>()
    for (const demands of this.bootstrapDemandsByOwner.values()) {
      for (const directory of demands.keys()) directories.add(directory)
    }
    for (const directory of this.manualBootstrapDemands.keys()) directories.add(directory)

    let changed = false
    for (const [directory] of this.bootstrapQueue) {
      if (directories.has(directory)) continue
      this.bootstrapQueue.delete(directory)
      if (this.bootstrapStates.get(directory) === "queued") this.bootstrapStates.delete(directory)
      changed = true
    }
    for (const directory of directories) {
      const demand = this.aggregateBootstrapDemand(directory)
      if (!demand) continue
      this.ensureChild(directory, { bootstrap: false })
      changed = this.queueBootstrap(demand, false) || changed
    }
    if (changed) this.notifyBootstrapSubscribers()
    this.pumpBootstrapQueue()
  }

  private queueBootstrap(demand: DirectoryBootstrapDemand, notify = true): boolean {
    const directory = demand.directory
    const store = this.children.get(directory)
    const state = this.bootstrapStates.get(directory)
    if (!demand.force && (state === "complete" || state === "failed" || store?.getState().status === "complete")) {
      return false
    }
    const running = this.runningBootstraps.get(directory)
    if (running) {
      if (demand.force) running.rerunRequested = true
      return false
    }
    const existing = this.bootstrapQueue.get(directory)
    const next: QueuedBootstrap = existing
      ? {
          ...existing,
          ...demand,
          priority: BOOTSTRAP_PRIORITY[demand.priority] < BOOTSTRAP_PRIORITY[existing.priority]
            ? demand.priority
            : existing.priority,
          force: Boolean(existing.force || demand.force),
        }
      : { ...demand, sequence: ++this.bootstrapSequence, enqueuedAt: Date.now() }
    const changed = !existing
      || next.priority !== existing.priority
      || next.reason !== existing.reason
      || next.force !== existing.force
    this.bootstrapQueue.set(directory, next)
    this.bootstrapStates.set(directory, "queued")
    if (changed && notify) this.notifyBootstrapSubscribers()
    this.pumpBootstrapQueue()
    return changed
  }

  private nextBootstrap(): QueuedBootstrap | undefined {
    const candidates = [...this.bootstrapQueue.values()].sort((left, right) => {
      const priority = BOOTSTRAP_PRIORITY[left.priority] - BOOTSTRAP_PRIORITY[right.priority]
      return priority !== 0 ? priority : left.sequence - right.sequence
    })
    const lowPriorityRunning = [...this.runningBootstraps.values()].filter(
      (entry) => BOOTSTRAP_PRIORITY[entry.priority] >= BOOTSTRAP_PRIORITY.visible,
    ).length
    return candidates.find((entry) => (
      BOOTSTRAP_PRIORITY[entry.priority] < BOOTSTRAP_PRIORITY.visible || lowPriorityRunning === 0
    ))
  }

  private pumpBootstrapQueue(): void {
    if (!this.onBootstrap || this.disposed) return
    while (this.runningBootstraps.size < this.bootstrapConcurrency) {
      const next = this.nextBootstrap()
      if (!next) return
      this.bootstrapQueue.delete(next.directory)
      const token = {}
      const running: RunningBootstrap = {
        ...next,
        generation: this.bootstrapGeneration,
        token,
        manualDemandRevision: this.manualBootstrapDemands.get(next.directory)?.revision,
      }
      this.runningBootstraps.set(next.directory, running)
      this.bootstrapStates.set(next.directory, "running")
      this.notifyBootstrapSubscribers()
      const finishPerformanceEvent = startSessionLoadPerformanceEvent({
        operation: "bootstrap.directory",
        directory: next.directory,
        caller: next.reason,
        queuedMs: Math.max(0, Date.now() - next.enqueuedAt),
      })

      const isCurrent = () => (
        !this.disposed
        && this.bootstrapGeneration === running.generation
        && this.runningBootstraps.get(next.directory)?.token === token
        && this.children.has(next.directory)
      )
      let bootstrapPromise: Promise<void>
      try {
        bootstrapPromise = Promise.resolve(this.onBootstrap({ ...next, generation: running.generation, isCurrent }))
      } catch (error) {
        bootstrapPromise = Promise.reject(error)
      }
      void bootstrapPromise
        .then(() => {
          if (isCurrent()) {
            this.bootstrapStates.set(next.directory, "complete")
            finishPerformanceEvent("complete")
          } else {
            finishPerformanceEvent("stale")
          }
        })
        .catch(() => {
          if (isCurrent()) {
            this.bootstrapStates.set(next.directory, "failed")
            finishPerformanceEvent("error")
          } else {
            finishPerformanceEvent("stale")
          }
        })
        .finally(() => {
          const executionBecameStale = this.bootstrapGeneration !== running.generation || this.disposed
          if (this.runningBootstraps.get(next.directory)?.token === token) {
            this.runningBootstraps.delete(next.directory)
          }
          const currentManualDemand = this.manualBootstrapDemands.get(next.directory)
          const hasNewForcedManualDemand = currentManualDemand !== undefined
            && currentManualDemand.revision !== running.manualDemandRevision
            && currentManualDemand.demand.force === true
          if (!executionBecameStale && !hasNewForcedManualDemand) {
            this.manualBootstrapDemands.delete(next.directory)
          }
          if ((executionBecameStale || hasNewForcedManualDemand || running.rerunRequested) && !this.disposed) {
            const demand = this.aggregateBootstrapDemand(next.directory)
            if (demand) this.queueBootstrap({ ...demand, force: true }, false)
          }
          this.notifyBootstrapSubscribers()
          this.pumpBootstrapQueue()
        })
    }
  }

  disposeDirectory(directory: string): boolean {
    if (
      !canDisposeDirectory({
        directory,
        hasStore: this.children.has(directory),
        pinned: this.pinned(directory),
        booting: this.bootstrapStates.get(directory) === "queued"
          || this.bootstrapStates.get(directory) === "running"
          || (this.isBooting?.(directory) ?? false),
        loadingSessions: this.isLoadingSessions?.(directory) ?? false,
        hasPendingBlockingRequests: this.hasPendingBlockingRequestsForDirectory(directory),
      })
    ) {
      return false
    }

    this.lifecycle.delete(directory)
    this.bootstrapQueue.delete(directory)
    this.manualBootstrapDemands.delete(directory)
    this.bootstrapStates.delete(directory)
    for (const demands of this.bootstrapDemandsByOwner.values()) demands.delete(directory)
    this.children.delete(directory)
    this.notifyRegistrySubscribers()
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
      hasPendingBlockingRequests: (dir) => this.hasPendingBlockingRequestsForDirectory(dir),
    }).filter((d) => d !== skip)
    for (const directory of list) {
      this.disposeDirectory(directory)
    }
  }

  hasPendingBlockingRequestsForDirectory(directory: string): boolean {
    return hasPendingBlockingRequests(this.children.get(directory)?.getState())
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
    this.disposed = true
    this.bootstrapGeneration += 1
    for (const directory of [...this.children.keys()]) {
      this.children.delete(directory)
    }
    this.notifyRegistrySubscribers()
    this.lifecycle.clear()
    this.pins.clear()
    this.disposers.clear()
    this.bootstrapQueue.clear()
    this.runningBootstraps.clear()
    this.bootstrapStates.clear()
    this.bootstrapDemandsByOwner.clear()
    this.manualBootstrapDemands.clear()
    this.notifyBootstrapSubscribers()
  }

  subscribeRegistry(listener: () => void): () => void {
    this.registrySubscribers.add(listener)
    return () => {
      this.registrySubscribers.delete(listener)
    }
  }

  subscribeAll(listener: () => void): () => void {
    const storeUnsubscribers = new Map<string, () => void>()

    const syncStoreSubscriptions = () => {
      const activeDirectories = new Set(this.children.keys())

      for (const [directory, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeDirectories.has(directory)) {
          continue
        }
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }

      for (const [directory, store] of this.children.entries()) {
        if (storeUnsubscribers.has(directory)) {
          continue
        }
        storeUnsubscribers.set(directory, store.subscribe(listener))
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

  subscribeAllSelected<T>(selector: (state: DirectoryStore) => T, listener: () => void): () => void {
    const storeUnsubscribers = new Map<string, () => void>()

    const syncStoreSubscriptions = () => {
      const activeDirectories = new Set(this.children.keys())

      for (const [directory, unsubscribe] of storeUnsubscribers.entries()) {
        if (activeDirectories.has(directory)) continue
        unsubscribe()
        storeUnsubscribers.delete(directory)
      }

      for (const [directory, store] of this.children.entries()) {
        if (storeUnsubscribers.has(directory)) continue
        storeUnsubscribers.set(directory, store.subscribe((state, previous) => {
          if (!Object.is(selector(state), selector(previous))) {
            listener()
          }
        }))
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
