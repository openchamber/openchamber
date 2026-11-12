import type { StoreApi } from "zustand/vanilla"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { getProtectedSessionCacheIds, pickSessionCacheEvictions } from "./session-cache"
import type { SessionMessageTarget } from "./session-message-loader"

/** How long a settled, unviewed session keeps its history before eviction. */
const SESSION_CACHE_IDLE_TTL_MS = 5 * 60 * 1000

type RetentionOptions = {
  limit: number
  idleTtlMs?: number
  isCurrent: () => boolean
  isViewed: (target: SessionMessageTarget) => boolean
  isProtected: (target: SessionMessageTarget) => boolean
  evict: (target: SessionMessageTarget) => void
}

type DirectoryEntry = {
  store: StoreApi<DirectoryStore>
  /** Navigation recency, oldest first. */
  seen: Set<string>
  /** When each cached session last became eligible for eviction. */
  idleSince: Map<string, number>
  timer: ReturnType<typeof setTimeout> | null
  unsubscribe: () => void
}

/**
 * Whole-session eviction, never partial trimming. A cached history is either
 * fully present or gone. Settled sessions nobody is looking at are dropped
 * after an idle grace period, so a quick return needs no request; the count
 * limit is a safety net that evicts the least recently visited session first.
 */
export class SessionCacheRetention {
  private readonly directories = new Map<string, DirectoryEntry>()
  private readonly pending = new Set<string>()
  private readonly unsubscribeRegistry: () => void
  private readonly idleTtlMs: number
  private disposed = false

  constructor(private readonly stores: ChildStoreManager, private readonly options: RetentionOptions) {
    this.idleTtlMs = options.idleTtlMs ?? SESSION_CACHE_IDLE_TTL_MS
    this.unsubscribeRegistry = stores.subscribeRegistry(() => this.attach())
    this.attach()
  }

  touch(target: SessionMessageTarget): void {
    const entry = this.directories.get(target.directory)
    if (!entry) return
    entry.seen.delete(target.sessionID)
    entry.seen.add(target.sessionID)
    this.schedule(target.directory)
  }

  admitPrefetch(target: SessionMessageTarget): boolean {
    const entry = this.directories.get(target.directory)
    if (!entry) return false
    const messages = entry.store.getState().message
    if (entry.seen.has(target.sessionID) || messages[target.sessionID] !== undefined) return true
    const occupied = new Set([...entry.seen, ...Object.keys(messages)])
    if (occupied.size >= this.options.limit) return false
    // Reserve capacity before HTTP starts. Speculative history is older than
    // every visited session and never promotes a cache hit's navigation recency.
    entry.seen = new Set([target.sessionID, ...entry.seen])
    return true
  }

  schedule(directory: string): void {
    if (this.disposed || this.pending.has(directory)) return
    this.pending.add(directory)
    queueMicrotask(() => {
      this.pending.delete(directory)
      if (!this.disposed && this.options.isCurrent()) this.clean(directory)
    })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribeRegistry()
    for (const entry of this.directories.values()) this.detach(entry)
    this.directories.clear()
    this.pending.clear()
  }

  private detach(entry: DirectoryEntry): void {
    entry.unsubscribe()
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }

  private attach(): void {
    for (const [directory, entry] of this.directories) {
      if (this.stores.getChild(directory) === entry.store) continue
      this.detach(entry)
      this.directories.delete(directory)
    }
    for (const [directory, store] of this.stores.children) {
      if (this.directories.has(directory)) continue
      const seen = new Set(Object.keys(store.getState().message))
      const unsubscribe = store.subscribe((state, previous) => {
        // Token/part deltas do not affect retention eligibility.
        if (state.message === previous.message
          && state.session_status === previous.session_status
          && state.permission === previous.permission
          && state.form === previous.form) return
        this.schedule(directory)
      })
      this.directories.set(directory, { store, seen, idleSince: new Map(), timer: null, unsubscribe })
      this.schedule(directory)
    }
  }

  private clean(directory: string): void {
    const entry = this.directories.get(directory)
    if (!entry) return
    const state = entry.store.getState()
    const protectedIds = getProtectedSessionCacheIds(state)
    for (const id of entry.seen) {
      if (state.message[id] === undefined && !this.options.isProtected({ directory, sessionID: id })) entry.seen.delete(id)
    }
    for (const id of Object.keys(state.message)) entry.seen.add(id)
    for (const sessionID of entry.seen) {
      const target = { directory, sessionID }
      if (this.options.isViewed(target) || this.options.isProtected(target)) protectedIds.add(sessionID)
    }
    const now = Date.now()
    const expired: string[] = []
    for (const sessionID of entry.seen) {
      if (protectedIds.has(sessionID)) {
        entry.idleSince.delete(sessionID)
        continue
      }
      const since = entry.idleSince.get(sessionID)
      if (since === undefined) entry.idleSince.set(sessionID, now)
      else if (now - since >= this.idleTtlMs) expired.push(sessionID)
    }
    const overflow = pickSessionCacheEvictions({ seen: entry.seen, limit: this.options.limit, preserve: protectedIds })
    for (const sessionID of new Set([...expired, ...overflow])) {
      entry.seen.delete(sessionID)
      entry.idleSince.delete(sessionID)
      this.options.evict({ directory, sessionID })
    }
    this.armTimer(entry, directory, now)
  }

  private armTimer(entry: DirectoryEntry, directory: string, now: number): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    let earliest: number | null = null
    for (const since of entry.idleSince.values()) {
      if (earliest === null || since < earliest) earliest = since
    }
    if (earliest === null) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.schedule(directory)
    }, Math.max(0, earliest + this.idleTtlMs - now))
  }
}
