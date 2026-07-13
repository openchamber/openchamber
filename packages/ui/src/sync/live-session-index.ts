/**
 * LiveSessionIndex — incremental merged view of all child stores.
 *
 * Replaces the O(N) scans previously done by:
 *   - useAllLiveSessions()  → aggregateLiveSessions(states)
 *   - useGlobalSessionStatus(id) → findLiveSessionStatus(states, id)
 *   - useAllSessionStatuses() → aggregateLiveSessionStatuses(states)
 *   - permissionStore.isSessionAutoAccepting(id) → getAllSyncSessions() + autoRespondsPermission
 *
 * The index subscribes to every child store's `store.subscribe` and applies
 * incremental per-store diffs to three internal Maps:
 *   - sessionsById     : freshest-wins per id (matches aggregateLiveSessions)
 *   - statusById       : freshest-wins per id (matches aggregateLiveSessionStatuses)
 *   - parentById       : child → parentID lookup, used for O(depth) lineage walk
 *
 * Public reads are O(1) (Map.get / a single sort cached behind a dirty flag).
 * The sort cache is invalidated only when a session is added/removed or its
 * sort-relevant fields change, so high-frequency events (message.part.delta,
 * permission.*, question.*, vcs.*, lsp.*, todo.*) do not bust it.
 *
 * The index is read-only from the outside; all mutation is internal.
 */

import type { StoreApi } from "zustand"
import type { Session } from "@opencode-ai/sdk/v2"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { DirectoryStore } from "./child-store"
import { ChildStoreManager } from "./child-store"
import type { State } from "./types"
import {
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  getStatusPriority,
  getSessionUpdatedAt,
} from "./live-aggregate"

export type { Session, SessionStatus }
export type { State }

const EMPTY_STATUS_MAP: Record<string, SessionStatus> = {}
const EMPTY_SESSIONS: Session[] = []
const EMPTY_LINEAGE: string[] = []

type SessionCandidate = {
  session: Session
  updatedAt: number
  directoryOrder: number
  directory: string
}

type StatusCandidate = {
  sessionId: string
  status: SessionStatus
  sessionUpdatedAt: number
  priority: number
  directoryOrder: number
  directory: string
}

const isBetterSessionCandidate = (next: SessionCandidate, current: SessionCandidate | undefined): boolean => {
  if (!current) return true
  if (next.updatedAt !== current.updatedAt) {
    return next.updatedAt > current.updatedAt
  }
  return next.directoryOrder >= current.directoryOrder
}

const isBetterStatusCandidate = (next: StatusCandidate, current: StatusCandidate | undefined): boolean => {
  if (!current) return true
  if (next.sessionUpdatedAt !== current.sessionUpdatedAt) {
    return next.sessionUpdatedAt > current.sessionUpdatedAt
  }
  if (next.priority !== current.priority) {
    return next.priority > current.priority
  }
  return next.directoryOrder >= current.directoryOrder
}

/**
 * LiveSessionIndex keeps the merged session/status view in sync with every
 * child store via incremental diffs. Construct one per SyncProvider mount.
 */
export class LiveSessionIndex {
  private readonly childStores: ChildStoreManager
  private readonly sessionsById = new Map<string, Session>()
  private readonly statusById = new Map<string, SessionStatus>()
  private readonly parentById = new Map<string, string | undefined>()
  private readonly sessionMetaById = new Map<string, SessionCandidate>()
  private readonly statusMetaById = new Map<string, StatusCandidate>()

  private sortedSessions: { value: Session[] | null } = { value: null }
  private statusSnapshot: { value: Record<string, SessionStatus> | null } = { value: null }
  private prevStatusMapForCompare: Record<string, SessionStatus> = EMPTY_STATUS_MAP
  private prevSessionListForCompare: Session[] = EMPTY_SESSIONS
  private readonly directoryOrderByName = new Map<string, number>()
  private nextDirectoryOrder = 0

  // Per-store previous views. Used to diff the new slice against the last
  // seen slice from THIS store (not against the merged map) so we can detect
  // session/status removals without iterating every store on every event.
  private readonly prevSessionsByStore = new Map<string, Session[]>()
  private readonly prevStatusByStore = new Map<string, Record<string, SessionStatus>>()

  private readonly subscribers = new Set<() => void>()

  private storeUnsubscribers = new Map<string, () => void>()
  private registryUnsubscribe: (() => void) | null = null
  private disposed = false

  /**
   * Static test factory: build an index directly from a list of state slices
   * without going through a real ChildStoreManager. Lets unit tests assert O(1)
   * behavior (no live child stores) and that a hot `message.part.delta` event
   * leaves the public getters referentially stable.
   */
  static fromStates(states: Array<Pick<State, "session" | "session_status">>): LiveSessionIndex {
    const fakeManager = {} as unknown as ChildStoreManager
    const index = new LiveSessionIndex(fakeManager)
    index.bulkIngest(states)
    return index
  }

  /**
   * Bulk-ingest a list of state slices for testing. Applies the same
   * freshest-wins merge rule as the per-store diff path, but without
   * per-store accounting (no removals; the last write wins per id).
   */
  private bulkIngest(states: Array<Pick<State, "session" | "session_status">>): void {
    let touched = false
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index]
      const directoryOrder = index
      const sessions = state.session ?? []
      const sessionById = new Map<string, Session>()
      for (const session of sessions) {
        if (!session?.id) continue
        sessionById.set(session.id, session)
      }

      for (const session of sessionById.values()) {
        const candidate: SessionCandidate = {
          session,
          updatedAt: getSessionUpdatedAt(session),
          directoryOrder,
          directory: `bulk:${directoryOrder}`,
        }
        touched = this.considerSessionCandidate(candidate) || touched
      }

      const statuses = state.session_status ?? {}
      for (const sessionId of Object.keys(statuses)) {
        const status = statuses[sessionId]
        const session = sessionById.get(sessionId)
        if (!session) continue
        const candidate: StatusCandidate = {
          sessionId,
          status,
          sessionUpdatedAt: getSessionUpdatedAt(session),
          priority: getStatusPriority(status),
          directoryOrder,
          directory: `bulk:${directoryOrder}`,
        }
        touched = this.considerStatusCandidate(candidate) || touched
      }
    }
    if (touched) {
      this.invalidateSortedCache()
      this.invalidateStatusCache()
    }
  }

  constructor(childStores: ChildStoreManager) {
    this.childStores = childStores
    this.attachToChildStores()
  }

  private getDirectoryOrder(directory: string): number {
    const existing = this.directoryOrderByName.get(directory)
    if (existing !== undefined) return existing
    const order = this.nextDirectoryOrder
    this.nextDirectoryOrder += 1
    this.directoryOrderByName.set(directory, order)
    return order
  }

  private considerSessionCandidate(candidate: SessionCandidate): boolean {
    const current = this.sessionMetaById.get(candidate.session.id)
    if (!isBetterSessionCandidate(candidate, current)) return false
    if (current?.session === candidate.session) return false
    this.sessionsById.set(candidate.session.id, candidate.session)
    this.sessionMetaById.set(candidate.session.id, candidate)
    this.parentById.set(candidate.session.id, (candidate.session as Session & { parentID?: string | null }).parentID)
    return true
  }

  private considerStatusCandidate(candidate: StatusCandidate): boolean {
    const sessionId = candidate.sessionId
    const current = this.statusMetaById.get(sessionId)
    if (!isBetterStatusCandidate(candidate, current)) return false
    if (current?.status === candidate.status) return false
    this.statusById.set(sessionId, candidate.status)
    this.statusMetaById.set(sessionId, candidate)
    return true
  }

  private attachToChildStores(): void {
    this.subscribeToAllChildren()
    if (typeof this.childStores.subscribeRegistry !== "function") {
      // Fake manager (e.g. LiveSessionIndex.fromStates for tests) — no
      // registry subscription available. Per-store subscriptions set up
      // above are enough; we just won't react to structural add/remove.
      return
    }
    this.registryUnsubscribe = this.childStores.subscribeRegistry(() => {
      this.subscribeToAllChildren()
      // Adding/removing a child store is a structural change — clear
      // everything and re-derive from the live stores. A new directory
      // mount or eviction changes which slices participate in the merge.
      this.invalidateAllCaches()
      this.prevSessionsByStore.clear()
      this.prevStatusByStore.clear()
      for (const [directory, store] of this.childStores.children.entries()) {
        const state = store.getState()
        this.ingestStateSlice(state, directory)
      }
      this.notifySubscribers()
    })
  }

  private subscribeToAllChildren(): void {
    const children = this.childStores.children
    if (!children) return
    const activeDirectories = new Set(children.keys())
    for (const [directory, unsubscribe] of this.storeUnsubscribers.entries()) {
      if (activeDirectories.has(directory)) continue
      unsubscribe()
      this.storeUnsubscribers.delete(directory)
      this.prevSessionsByStore.delete(directory)
      this.prevStatusByStore.delete(directory)
    }
    for (const [directory, store] of children.entries()) {
      if (this.storeUnsubscribers.has(directory)) continue
      const initialState = store.getState()
      this.ingestStateSlice(initialState, directory)
      const unsubscribe = store.subscribe(() => this.handleStoreChange(store, directory))
      this.storeUnsubscribers.set(directory, unsubscribe)
    }
  }

  private handleStoreChange(store: StoreApi<DirectoryStore>, directory: string): void {
    if (this.disposed) return
    this.ingestStateSlice(store.getState(), directory)
  }

  /**
   * Apply a state slice to the index incrementally. Called for initial
   * ingestion (constructor and fromStates) and on every store change. The
   * diff is between the slice's CURRENT and the slice's PREVIOUS view of
   * ITSELF (not the merged map), so a hot `message.part.delta` event that
   * doesn't touch session or session_status leaves both Maps and the
   * sorted cache untouched and does not fire a notify.
   */
  private ingestStateSlice(state: Pick<State, "session" | "session_status">, directory: string): void {
    const nextSessions = state.session ?? []
    const nextStatuses = state.session_status ?? {}

    // Hot-path short-circuit. The reducer keeps `state.session` and
    // `state.session_status` reference-stable for high-frequency events
    // (message.part.delta, permission.*, question.*, vcs.*, lsp.*, todo.*).
    // If both references match the last observation for this store, the
    // slice is unchanged and there is nothing to do.
    const observedPrevSessions = this.prevSessionsByStore.get(directory)
    const observedPrevStatuses = this.prevStatusByStore.get(directory)
    if (
      (observedPrevSessions !== undefined || observedPrevStatuses !== undefined)
      && observedPrevSessions === nextSessions
      && observedPrevStatuses === nextStatuses
    ) {
      return
    }

    const prevSessions = observedPrevSessions ?? EMPTY_SESSIONS
    const prevStatuses = observedPrevStatuses ?? EMPTY_STATUS_MAP
    const directoryOrder = this.getDirectoryOrder(directory)

    // --- Sessions diff for this store ---
    const prevSessionById = new Map<string, Session>()
    for (const s of prevSessions) {
      if (s?.id) prevSessionById.set(s.id, s)
    }
    const nextSessionById = new Map<string, Session>()
    for (const s of nextSessions) {
      if (s?.id) nextSessionById.set(s.id, s)
    }

    let sessionsTouched = false

    // Added / changed
    for (const next of nextSessionById.values()) {
      const candidate: SessionCandidate = {
        session: next,
        updatedAt: getSessionUpdatedAt(next),
        directoryOrder,
        directory,
      }
      sessionsTouched = this.considerSessionCandidate(candidate) || sessionsTouched
    }

    // Removed (was in prev slice, no longer in next slice)
    for (const [id] of prevSessionById.entries()) {
      if (nextSessionById.has(id)) continue
      const current = this.sessionMetaById.get(id)
      if (!current || current.directory !== directory) continue
      const replacement = this.findBestSessionReplacement(id, directory)
      if (replacement) {
        this.sessionsById.set(id, replacement.session)
        this.sessionMetaById.set(id, replacement)
        this.parentById.set(id, (replacement.session as Session & { parentID?: string | null }).parentID)
      } else {
        this.sessionsById.delete(id)
        this.sessionMetaById.delete(id)
        this.parentById.delete(id)
      }
      sessionsTouched = true
    }

    // --- Statuses diff for this store ---
    let statusesTouched = false
    for (const sessionId of Object.keys(nextStatuses)) {
      const next = nextStatuses[sessionId]
      const session = nextSessionById.get(sessionId)
      if (!session) continue
      const candidate: StatusCandidate = {
        sessionId,
        status: next,
        sessionUpdatedAt: getSessionUpdatedAt(session),
        priority: getStatusPriority(next),
        directoryOrder,
        directory,
      }
      statusesTouched = this.considerStatusCandidate(candidate) || statusesTouched
    }
    for (const sessionId of Object.keys(prevStatuses)) {
      if (sessionId in nextStatuses) continue
      const current = this.statusMetaById.get(sessionId)
      if (!current || current.directory !== directory) continue
      const replacement = this.findBestStatusReplacement(sessionId, directory)
      if (replacement) {
        this.statusById.set(sessionId, replacement.status)
        this.statusMetaById.set(sessionId, replacement)
      } else {
        this.statusById.delete(sessionId)
        this.statusMetaById.delete(sessionId)
      }
      statusesTouched = true
    }

    this.prevSessionsByStore.set(directory, nextSessions)
    this.prevStatusByStore.set(directory, nextStatuses)

    if (sessionsTouched) this.invalidateSortedCache()
    if (statusesTouched) this.invalidateStatusCache()
    if (sessionsTouched || statusesTouched) this.notifySubscribers()
  }

  private findBestSessionReplacement(id: string, excludeDir: string): SessionCandidate | undefined {
    let best: SessionCandidate | undefined
    for (const [directory, store] of this.childStores.children.entries()) {
      if (directory === excludeDir) continue
      const directoryOrder = this.getDirectoryOrder(directory)
      const list = store.getState().session
      for (const s of list) {
        if (s?.id !== id) continue
        const next: SessionCandidate = {
          session: s,
          updatedAt: getSessionUpdatedAt(s),
          directoryOrder,
          directory,
        }
        if (isBetterSessionCandidate(next, best)) {
          best = next
        }
      }
    }
    return best
  }

  private findBestStatusReplacement(id: string, excludeDir: string): StatusCandidate | undefined {
    let best: StatusCandidate | undefined
    for (const [directory, store] of this.childStores.children.entries()) {
      if (directory === excludeDir) continue
      const directoryOrder = this.getDirectoryOrder(directory)
      const state = store.getState()
      const statuses = state.session_status ?? EMPTY_STATUS_MAP
      const session = state.session.find((candidate) => candidate.id === id)
      if (!session || !(id in statuses)) continue
      const next: StatusCandidate = {
        sessionId: id,
        status: statuses[id],
        sessionUpdatedAt: getSessionUpdatedAt(session),
        priority: getStatusPriority(statuses[id]),
        directoryOrder,
        directory,
      }
      if (isBetterStatusCandidate(next, best)) {
        best = next
      }
    }
    return best
  }

  private invalidateAllCaches(): void {
    this.sessionsById.clear()
    this.statusById.clear()
    this.parentById.clear()
    this.sessionMetaById.clear()
    this.statusMetaById.clear()
    this.directoryOrderByName.clear()
    this.nextDirectoryOrder = 0
    this.invalidateSortedCache()
    this.invalidateStatusCache()
  }

  private invalidateSortedCache(): void {
    this.sortedSessions.value = null
  }

  private invalidateStatusCache(): void {
    this.statusSnapshot.value = null
  }

  private notifySubscribers(): void {
    for (const listener of this.subscribers) listener()
  }

  // ------------------------------------------------------------------
  // Public read API
  // ------------------------------------------------------------------

  /**
   * Sorted session list (by time.updated desc). Cached. Reference-stable
   * when contents are unchanged.
   */
  getAllSessions(): Session[] {
    if (this.sortedSessions.value !== null) return this.sortedSessions.value

    const next = Array.from(this.sessionsById.values()).sort((left, right) => {
      return getSessionUpdatedAt(right) - getSessionUpdatedAt(left)
    })
    // Preserve reference if contents are equivalent to the previous emission.
    if (areSessionListsEquivalent(this.prevSessionListForCompare, next)) {
      this.sortedSessions.value = this.prevSessionListForCompare
    } else {
      this.sortedSessions.value = next
      this.prevSessionListForCompare = next
    }
    return this.sortedSessions.value
  }

  /** O(1) status lookup. */
  getStatus(id: string | null | undefined): SessionStatus | undefined {
    if (!id) return undefined
    return this.statusById.get(id)
  }

  /** O(1) session lookup. */
  getSession(id: string | null | undefined): Session | undefined {
    if (!id) return undefined
    return this.sessionsById.get(id)
  }

  /**
   * Snapshot of all statuses. Reference-stable across no-op updates (uses
   * areStatusMapsEquivalent).
   */
  getAllStatuses(): Record<string, SessionStatus> {
    if (this.statusSnapshot.value !== null) return this.statusSnapshot.value

    const next: Record<string, SessionStatus> = {}
    for (const [sessionId, status] of this.statusById.entries()) {
      next[sessionId] = status
    }
    if (areStatusMapsEquivalent(this.prevStatusMapForCompare, next)) {
      this.statusSnapshot.value = this.prevStatusMapForCompare
    } else {
      this.statusSnapshot.value = next
      this.prevStatusMapForCompare = next
    }
    return this.statusSnapshot.value
  }

  /**
   * Walk the parent chain for `id` (including `id` itself). O(depth) — does
   * not iterate sessions. Returns an empty array if `id` is unknown.
   */
  getLineage(id: string): string[] {
    if (!id) return EMPTY_LINEAGE
    if (!this.sessionsById.has(id)) return EMPTY_LINEAGE
    const result: string[] = []
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) {
      seen.add(current)
      result.push(current)
      current = this.parentById.get(current)
    }
    return result
  }

  /**
   * Subscribe to index changes. Used by React via useSyncExternalStore.
   */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /**
   * Tear down. After dispose() the index is inert — reads return empty
   * snapshots, subscriptions are detached.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.storeUnsubscribers.values()) {
      unsubscribe()
    }
    this.storeUnsubscribers.clear()
    this.registryUnsubscribe?.()
    this.registryUnsubscribe = null
    this.subscribers.clear()
  }

  /**
   * Whether dispose() has been called. After dispose() the index is inert
   * (handleStoreChange short-circuits, public getters may return stale
   * snapshots, no notifications will fire). React StrictMode in dev mounts
   * the SyncProvider twice in immediate succession — the cleanup effect
   * disposes the first instance, then the second mount must create a
   * fresh index instead of reusing the disposed one. The SyncProvider
   * guard checks this accessor before reusing a cached index.
   */
  isDisposed(): boolean {
    return this.disposed
  }

  // ------------------------------------------------------------------
  // Test-only accessors. Not used by production code.
  // ------------------------------------------------------------------

  /** @internal — count of internal sessions (for tests). */
  __test_sessionCount(): number {
    return this.sessionsById.size
  }

  /** @internal — count of internal statuses (for tests). */
  __test_statusCount(): number {
    return this.statusById.size
  }
}
