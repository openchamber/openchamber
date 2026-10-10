import type { Message, Part } from "@/lib/opencode/model"
import type { MessagePage } from "@/lib/opencode/client"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { retry } from "./retry"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"
import { findMessageIndex, insertMessageChronologically, sortMessagesChronologically } from "./message-ordering"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import {
  clearDirectorySessionPrefetch,
  clearRuntimeSessionPrefetch,
  clearSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
} from "./session-prefetch-cache"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { normalizePath } from "@/lib/pathNormalization"
import { startSessionLoadPerformanceEvent } from "./session-load-performance"
import { dropSessionCaches } from "./session-cache"
import { SessionCacheRetention } from "./session-cache-retention"
import { SESSION_CACHE_LIMIT } from "./types"

// One agent turn can span well over a hundred tool steps, so the first
// request is sized to hold a long last turn without a follow-up read.
const INITIAL_MESSAGE_PAGE_SIZE = 100
const CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE = 50
const HISTORY_MESSAGE_PAGE_SIZE = 100
// Extra pages one interactive history action may read to reach a user prompt.
const HISTORY_TURN_ALIGNMENT_EXTRA_PAGES = 2
// Cold navigation aims for this many user-led turns within the expansion bounds.
const INITIAL_USER_TURNS = 10
const CONSTRAINED_SESSION_CACHE_LIMIT = 6
// Cold navigation extends the first page backward through the cursor until
// INITIAL_USER_TURNS prompts are present or this many records are held. The
// ceiling never stops it before the newest prompt. Nothing already downloaded
// is requested again.
const INITIAL_WINDOW_MAX_RECORDS = 300
const CONSTRAINED_INITIAL_WINDOW_MAX_RECORDS = 200
// OpenCode rejects a message page larger than this.
const MAX_MESSAGE_PAGE_SIZE = 200
// An extension page is sized from the turn density already fetched, with this
// headroom so uneven turns rarely need one more round trip.
const EXTENSION_ESTIMATE_HEADROOM = 1.2
// Tail read that confirms a cached transcript after a stream gap. It usually
// overlaps the cache; when it does not, the window is read back further.
const STALE_HISTORY_TAIL_LIMIT = 30

export type SessionMessageTarget = {
  directory: string
  sessionID: string
}

export type SessionMessageLoadKind = "initial" | "older" | "refresh" | "prefetch"
export type SessionMessageLoadStatus = "idle" | "loading" | "ready" | "error"

export type SessionMessageLoadState = {
  status: SessionMessageLoadStatus
  loadingKind: SessionMessageLoadKind | null
  error: Error | null
  resolved: boolean
  limit: number
  cursor: string | undefined
  complete: boolean
  generation: number
  updatedAt: number | undefined
}

type LoaderEntry = {
  target: SessionMessageTarget
  snapshot: SessionMessageLoadState
  listeners: Set<() => void>
  inflight: Promise<void> | null
  queuedRefresh: Promise<void> | null
  queuedRefreshLimit: number
  optimistic: Map<string, OptimisticItem>
  /** History was dropped by retention; events since then are not coverage. */
  evicted: boolean
  /**
   * The loader's history epoch at the start of the last authoritative read
   * that confirmed this transcript. Older than the current epoch means a
   * stream gap may have hidden changes from it.
   */
  verifiedEpoch: number
  /**
   * The newest cached record when the first stream gap after the last
   * confirmation happened. Records before it are known contiguous; records
   * after it may have arrived by live events with a hole behind them, so a
   * stale tail refresh joins the cache only through this record.
   */
  gapAnchorID: string | null
}

type FetchedPage = {
  session: Message[]
  partsByMessageID: Map<string, Part[]>
  cursor: string | undefined
  complete: boolean
}

type LoadPerformanceDetails = {
  retryCount: number
  recordCount: number
}

/**
 * The loader only needs one page call. Narrowing the dependency to that call
 * keeps the adapter (`opencodeClient`) the single place that knows how the
 * server encodes messages, and keeps tests free of a whole SDK double.
 */
export type SessionMessagePageSource = {
  getSessionMessages(
    id: string,
    options?: { limit?: number; cursor?: string; order?: "asc" | "desc" },
    directory?: string | null,
  ): Promise<MessagePage>
}

type LoaderConfiguration = {
  sdk: SessionMessagePageSource
  runtimeKey: string
}

/** OpenCode's first connection of the page (`openCodeStartupSignal`). */
type OpenCodeStartupSignal = {
  isStarting(): boolean
  /** Resolves on the first connection; rejects when OpenCode does not come up. */
  waitForConnection(): Promise<void>
}

const NO_OPENCODE_STARTUP: OpenCodeStartupSignal = {
  isStarting: () => false,
  waitForConnection: () => Promise.resolve(),
}

const isConstrainedRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getInitialPageSize = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE
  : INITIAL_MESSAGE_PAGE_SIZE
const getInitialWindowMaxRecords = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_WINDOW_MAX_RECORDS
  : INITIAL_WINDOW_MAX_RECORDS

const isUserMessage = (message: Message): boolean => message.role === "user"

const hasUserMessage = (messages: Message[]): boolean => messages.some(isUserMessage)

const countUserMessages = (messages: Message[]): number => {
  let turns = 0
  for (const message of messages) if (isUserMessage(message)) turns += 1
  return turns
}

const hasInitialTurns = (messages: Message[]): boolean => countUserMessages(messages) >= INITIAL_USER_TURNS

/**
 * Drops the cached records a replacing window no longer covers, so older
 * cached history cannot sit behind a hole. Kept: records the window carries,
 * optimistic records, and records newer than the window, which arrived live
 * while it was read.
 */
const withoutHistoryOutsideWindow = (
  state: DirectoryStore,
  sessionID: string,
  page: FetchedPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
): DirectoryStore => {
  const messages = state.message[sessionID]
  if (!messages) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const newestWindowTime = page.session.at(-1)?.time.created ?? Number.NEGATIVE_INFINITY
  const dropped: string[] = []
  const kept = messages.filter((message) => {
    if (pageIDs.has(message.id) || optimistic.has(message.id) || message.time.created > newestWindowTime) return true
    dropped.push(message.id)
    return false
  })
  if (dropped.length === 0) return state
  const part = { ...state.part }
  for (const messageID of dropped) delete part[messageID]
  return { ...state, message: { ...state.message, [sessionID]: kept }, part }
}

/**
 * Drops the client's own copies of records the page now carries, so the
 * server's version replaces them instead of losing to them as an existing
 * record. An optimistic prompt is stamped with the browser's clock, the reply
 * with the server's; a remote client whose clock runs ahead would otherwise
 * keep its prompt sorted after the reply until a reload. A copy a live event
 * already replaced is no longer the optimistic object and is left alone.
 */
const withoutEchoedOptimisticRecords = (
  state: DirectoryStore,
  sessionID: string,
  page: FetchedPage,
  optimistic: ReadonlyMap<string, OptimisticItem>,
): DirectoryStore => {
  const messages = state.message[sessionID]
  if (!messages || optimistic.size === 0) return state
  const pageIDs = new Set(page.session.map((message) => message.id))
  const kept = messages.filter((message) => (
    !pageIDs.has(message.id) || optimistic.get(message.id)?.message !== message
  ))
  return kept.length === messages.length ? state : { ...state, message: { ...state.message, [sessionID]: kept } }
}

const toLoadError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("Session messages could not be loaded")

const filterIdentifiedParts = (parts: Part[]): Part[] => parts
  .filter((part) => Boolean(part?.id))

const createDefaultState = (generation = 0): SessionMessageLoadState => ({
  status: "idle",
  loadingKind: null,
  error: null,
  resolved: false,
  limit: getInitialPageSize(),
  cursor: undefined,
  complete: false,
  generation,
  updatedAt: undefined,
})

export const EMPTY_SESSION_MESSAGE_LOAD_STATE = createDefaultState()

export class SessionMessageLoader {
  private sdk: SessionMessagePageSource
  private runtimeKey: string
  private sdkEpoch = 0
  /** Advances on every stream gap; see `markHistoryStale`. */
  private historyEpoch = 0
  private disposed = false
  private readonly entries = new Map<string, LoaderEntry>()
  private retention: SessionCacheRetention | null = null
  private releaseDerivedCache: (target: SessionMessageTarget) => void = () => undefined
  private readonly historyReaders = new Map<string, number>()
  private readonly renderedSessions = new Map<string, number>()

  constructor(
    private readonly childStores: ChildStoreManager,
    configuration: LoaderConfiguration,
    private readonly openCodeStartup: OpenCodeStartupSignal = NO_OPENCODE_STARTUP,
  ) {
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
  }

  configure(configuration: LoaderConfiguration): void {
    if (this.sdk === configuration.sdk && this.runtimeKey === configuration.runtimeKey) return
    const runtimeChanged = this.runtimeKey !== configuration.runtimeKey
    const previousRuntimeKey = this.runtimeKey
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      entry.snapshot = {
        ...entry.snapshot,
        status: entry.snapshot.resolved ? "ready" : "idle",
        loadingKind: null,
        error: null,
        generation: entry.snapshot.generation + 1,
      }
      entry.inflight = null
      this.notify(entry)
    }
    if (runtimeChanged) {
      this.entries.clear()
      clearRuntimeSessionPrefetch(previousRuntimeKey)
    }
  }

  /**
   * Re-enable a loader which was disposed by a transient React effect cleanup.
   *
   * React Strict Mode runs effect setup, cleanup, then setup again in
   * development. The provider owns one ref-stable loader across that sequence,
   * so the second setup must be able to accept new work after the first cleanup
   * invalidated its in-flight requests.
   */
  activate(): void {
    this.disposed = false
  }

  startCacheRetention(options: {
    idleTtlMs?: number
    isCurrent: () => boolean
    isViewed: (target: SessionMessageTarget) => boolean
    isActive: (target: SessionMessageTarget) => boolean
    releaseDerivedCache: (target: SessionMessageTarget) => void
  }): () => void {
    this.retention?.dispose()
    this.releaseDerivedCache = options.releaseDerivedCache
    const retention = new SessionCacheRetention(this.childStores, {
      limit: isConstrainedRuntime() ? CONSTRAINED_SESSION_CACHE_LIMIT : SESSION_CACHE_LIMIT,
      idleTtlMs: options.idleTtlMs,
      isCurrent: options.isCurrent,
      isViewed: options.isViewed,
      isProtected: (target) => {
        const key = this.keyFor(target)
        const entry = this.entries.get(key)
        return options.isActive(target) || Boolean(this.historyReaders.get(key))
          || Boolean(this.renderedSessions.get(key))
          || Boolean(entry?.inflight) || Boolean(entry?.optimistic.size)
      },
      evict: (target) => this.evictSessionHistory(target),
    })
    this.retention = retention
    return () => {
      retention.dispose()
      if (this.retention === retention) this.retention = null
    }
  }

  touchSessionCache(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (normalized) this.retention?.touch(normalized)
  }

  scheduleCacheRetention(directory: string): void {
    const normalized = normalizePath(directory)
    if (normalized) this.retention?.schedule(normalized)
  }

  /** Hold history for an imperative reader or a transcript still on screen. */
  retainSessionHistory(target: SessionMessageTarget, reason: "read" | "rendered" = "read"): () => void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return () => undefined
    const key = this.keyFor(normalized)
    const holders = reason === "rendered" ? this.renderedSessions : this.historyReaders
    holders.set(key, (holders.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (holders.get(key) ?? 1) - 1
      if (remaining > 0) holders.set(key, remaining)
      else holders.delete(key)
      this.scheduleCacheRetention(normalized.directory)
    }
  }

  private evictSessionHistory(target: SessionMessageTarget): void {
    const store = this.childStores.getChild(target.directory)
    if (!store) return
    const current = store.getState()
    const draft = {
      message: { ...current.message }, part: { ...current.part },
      session_status: { ...current.session_status }, permission: { ...current.permission },
      form: { ...current.form },
    }
    this.invalidateSession(target)
    this.getEntry(target).evicted = true
    clearSessionPrefetch(target.directory, [target.sessionID], this.runtimeKey)
    dropSessionCaches(draft, [target.sessionID])
    this.releaseDerivedCache(target)
    store.setState(draft)
  }

  initializeCreatedSession(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const current = store.getState()
    // The create response establishes an empty transcript, but events or a
    // prompt may already have materialized a newer snapshot while it travelled.
    if (current.message[normalized.sessionID] !== undefined) return
    const entry = this.getEntry(normalized)
    this.bumpGeneration(entry)
    entry.inflight = null
    entry.verifiedEpoch = this.historyEpoch
    store.setState({ message: { ...current.message, [normalized.sessionID]: [] } })
    this.patchEntry(entry, {
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      cursor: undefined,
      complete: true,
      updatedAt: Date.now(),
    })
    this.persistCoverage(normalized, entry.snapshot)
  }

  ensure(
    target: SessionMessageTarget,
    options?: { force?: boolean; reason?: "navigation" | "reactive" | "prefetch" },
  ): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const materialization = getSessionMaterializationStatus(store.getState(), normalized.sessionID)
    if (options?.reason !== "prefetch") this.touchSessionCache(normalized)
    // Messages that arrived by event after an eviction are renderable but are
    // not history coverage: the earlier transcript must be fetched again.
    if (!options?.force && materialization.renderable && !entry.evicted) {
      if (!entry.snapshot.resolved) {
        this.patchEntry(entry, {
          status: "ready",
          error: null,
          resolved: true,
          limit: Math.max(entry.snapshot.limit, store.getState().message[normalized.sessionID]?.length ?? 0),
        })
      }
      // The cached transcript renders now; a gap-stale one refreshes behind it.
      if (options?.reason !== "prefetch" && this.revalidateIfStale(normalized)) return Promise.resolve()
      return entry.inflight ?? Promise.resolve()
    }
    if (entry.inflight) {
      if (options?.reason !== "prefetch" && entry.snapshot.loadingKind === "prefetch") {
        this.patchEntry(entry, { loadingKind: "initial" })
      }
      return entry.inflight
    }
    if (options?.force) this.bumpGeneration(entry)
    const kind: SessionMessageLoadKind = options?.reason === "prefetch" ? "prefetch" : "initial"
    // A session opened before OpenCode is ready (the launch reopening the
    // last session, a link) reads at once: OpenCode may already answer. If
    // that read fails, the failure says nothing about the session, so the
    // load stays loading and reads once more when OpenCode connects. Only a
    // failure after that, or OpenCode not starting at all, becomes an error.
    // A prefetch does not wait, unless a foreground caller joined it since.
    const startedBeforeOpenCode = this.openCodeStartup.isStarting()
    return this.startLoad(normalized, entry, store, kind, async (isCurrent, performance) => {
      try {
        await this.loadInitial(normalized, entry, store, isCurrent, performance)
      } catch (error) {
        if (!startedBeforeOpenCode || entry.snapshot.loadingKind === "prefetch" || !isCurrent()) throw error
        await this.openCodeStartup.waitForConnection()
        if (!isCurrent()) return
        await this.loadInitial(normalized, entry, store, isCurrent, performance)
      }
    })
  }

  /**
   * The event stream had a gap: any cached transcript may have missed
   * changes. Each one refreshes its tail the next time it is opened.
   */
  markHistoryStale(): void {
    for (const entry of this.entries.values()) {
      // An entry already stale keeps the anchor of its first gap: an older
      // anchor only makes the tail read back further.
      if (!entry.snapshot.resolved || entry.verifiedEpoch < this.historyEpoch) continue
      const messages = this.childStores.getChild(entry.target.directory)?.getState().message[entry.target.sessionID] ?? []
      const confirmed = messages.filter((message) => !entry.optimistic.has(message.id))
      entry.gapAnchorID = confirmed.at(-1)?.id ?? null
    }
    this.historyEpoch += 1
  }

  /**
   * Refreshes a cached transcript in the background when a stream gap
   * happened after it was last confirmed. Returns whether a refresh started.
   * A failed refresh keeps the cached records and the stale mark.
   */
  revalidateIfStale(target: SessionMessageTarget): boolean {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return false
    const entry = this.entries.get(this.keyFor(normalized))
    if (!entry?.snapshot.resolved || entry.inflight || entry.verifiedEpoch >= this.historyEpoch) return false
    void this.refreshTail(normalized, STALE_HISTORY_TAIL_LIMIT)
    return true
  }

  prefetch(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    if (this.retention && !this.retention.admitPrefetch(normalized)) return Promise.resolve()
    return this.ensure(normalized, { reason: "prefetch" })
  }

  loadOlder(target: SessionMessageTarget): Promise<void> {
    return this.loadOlderPage(target, "interactive")
  }

  private loadOlderPage(target: SessionMessageTarget, mode: "interactive" | "complete"): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) {
      if (entry.snapshot.loadingKind === "older") return entry.inflight
      return entry.inflight.then(() => this.loadOlderPage(normalized, mode))
    }
    if (entry.snapshot.complete || !entry.snapshot.cursor) return Promise.resolve()
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const cursor = entry.snapshot.cursor
    return this.startLoad(normalized, entry, store, "older", async (isCurrent, performance) => {
      let page = await this.fetchPage(normalized, HISTORY_MESSAGE_PAGE_SIZE, cursor, "older", performance)
      if (!isCurrent()) return
      const visited = new Set([cursor])
      // An interactive batch tries to start on a user prompt so the oldest
      // visible turn is whole. Every fetched record is kept, and the server
      // cursor stays authoritative. Alignment reads are bounded, except that a
      // batch holding no prompt at all would add nothing visible: it keeps
      // reading until the turn's prompt arrives.
      for (let extra = 0; mode === "interactive"; extra += 1) {
        if (page.complete || !page.session[0] || isUserMessage(page.session[0])) break
        if (extra >= HISTORY_TURN_ALIGNMENT_EXTRA_PAGES && hasUserMessage(page.session)) break
        if (!page.cursor || visited.has(page.cursor)) throw new Error("Session history pagination made no progress")
        visited.add(page.cursor)
        const older = await this.fetchPage(normalized, HISTORY_MESSAGE_PAGE_SIZE, page.cursor, "older", performance)
        if (!isCurrent()) return
        if (older.session.length === 0 && !older.complete) throw new Error("Session history pagination made no progress")
        page = {
          session: [...older.session, ...page.session],
          partsByMessageID: new Map([...page.partsByMessageID, ...older.partsByMessageID]),
          cursor: older.cursor,
          complete: older.complete,
        }
      }
      // Commit the whole batch atomically. A failed follow-up read keeps the
      // previous visible history and its retry cursor intact.
      const committed = this.commitPage(normalized, entry, store, page, "prepend", isCurrent)
      if (!committed || !isCurrent()) return
      this.patchEntry(entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: Math.max(entry.snapshot.limit, committed.messages.length),
        cursor: page.cursor,
        complete: page.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  async loadComplete(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) throw new Error("Session message loader is unavailable")
    const release = this.retainSessionHistory(normalized)
    try {
      const initial = this.getSnapshot(normalized)
      await this.ensure(normalized, { force: !initial.resolved })

      const visitedCursors = new Set<string>()
      while (true) {
        const snapshot = this.getSnapshot(normalized)
        if (snapshot.status === "error") throw snapshot.error ?? new Error("Session history could not be loaded")
        if (snapshot.complete) return
        if (!snapshot.cursor) throw new Error("Session history coverage is unresolved")
        if (visitedCursors.has(snapshot.cursor)) {
          throw new Error("Session history pagination made no progress")
        }
        visitedCursors.add(snapshot.cursor)

        await this.loadOlderPage(normalized, "complete")
      }
    } finally {
      release()
    }
  }

  refreshTail(target: SessionMessageTarget, limit: number): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) {
      entry.queuedRefreshLimit = Math.max(entry.queuedRefreshLimit, limit)
      if (entry.queuedRefresh) return entry.queuedRefresh
      const inflight = entry.inflight
      const entryKey = this.keyFor(normalized)
      const generation = entry.snapshot.generation
      const sdkEpoch = this.sdkEpoch
      const clearQueuedRefresh = () => {
        if (entry.queuedRefresh !== queuedRefresh) return
        entry.queuedRefresh = null
        entry.queuedRefreshLimit = 0
      }
      const queuedRefresh = inflight.then(() => {
        if (
          this.disposed
          || this.sdkEpoch !== sdkEpoch
          || entry.snapshot.generation !== generation
          || this.entries.get(entryKey) !== entry
        ) {
          clearQueuedRefresh()
          return
        }
        const refreshLimit = entry.queuedRefreshLimit
        clearQueuedRefresh()
        return this.refreshTail(normalized, refreshLimit)
      })
      entry.queuedRefresh = queuedRefresh
      return queuedRefresh
    }
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    this.bumpGeneration(entry)
    return this.startLoad(normalized, entry, store, "refresh", async (isCurrent, performance) => {
      const epoch = this.historyEpoch
      const previousCoverage = entry.snapshot.resolved
        ? { cursor: entry.snapshot.cursor, complete: entry.snapshot.complete }
        : null
      // The tail must join the cached history. When more records arrived
      // than the tail holds, merging it would leave a hole behind it: read
      // back until it joins, or replace the cache with a fresh window.
      // Without a gap the cache is contiguous, so any record cached before
      // this read is a join point. After a gap, records that arrived by live
      // events may sit past a hole, so only the gap anchor is; a stale entry
      // without one cannot prove a join and takes a fresh window.
      const joinIDs = entry.verifiedEpoch < epoch
        ? new Set(entry.gapAnchorID ? [entry.gapAnchorID] : [])
        : new Set((store.getState().message[normalized.sessionID] ?? [])
          .filter((message) => !entry.optimistic.has(message.id))
          .map((message) => message.id))
      let page = await this.fetchPage(normalized, Math.max(1, limit), undefined, "refresh", performance)
      if (!isCurrent()) return
      let replacesCache = false
      if (previousCoverage) {
        const joinsCache = (window: FetchedPage) => window.session.some((message) => joinIDs.has(message.id))
        const window = await this.extendWindow(normalized, page, {
          isSatisfied: (candidate) => joinsCache(candidate) || hasInitialTurns(candidate.session),
          targetTurns: INITIAL_USER_TURNS,
        }, isCurrent, performance)
        if (!window) return
        page = window
        replacesCache = !page.complete && !joinsCache(page)
      }
      const committed = this.commitPage(normalized, entry, store, page, replacesCache ? "replace" : "merge", isCurrent)
      if (!committed || !isCurrent()) return
      entry.verifiedEpoch = Math.max(entry.verifiedEpoch, epoch)
      // A tail that joins the cache uses a deliberately small window: its
      // cursor describes only that window and must not replace the
      // established coverage, unless the tail holds the whole history.
      const coverage = replacesCache || page.complete || !previousCoverage ? page : previousCoverage
      this.patchEntry(entry, {
        status: "ready",
        loadingKind: null,
        error: null,
        resolved: true,
        limit: replacesCache ? committed.messages.length : Math.max(entry.snapshot.limit, committed.messages.length),
        cursor: coverage.cursor,
        complete: coverage.complete,
        updatedAt: Date.now(),
      })
      this.persistCoverage(normalized, entry.snapshot)
    })
  }

  getSnapshot(target: SessionMessageTarget): SessionMessageLoadState {
    const normalized = this.normalizeTarget(target)
    return normalized ? this.getEntry(normalized).snapshot : EMPTY_SESSION_MESSAGE_LOAD_STATE
  }

  subscribe(target: SessionMessageTarget, listener: () => void): () => void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return () => undefined
    const entry = this.getEntry(normalized)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  optimisticAdd(input: SessionMessageTarget & { message: Message; parts: Part[] }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    entry.optimistic.set(input.message.id, { message: input.message, parts: filterIdentifiedParts(input.parts) })
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const messages = current.message[target.sessionID] ? [...current.message[target.sessionID]] : []
    if (findMessageIndex(messages, input.message.id) < 0) {
      insertMessageChronologically(messages, input.message)
    }
    store.setState({
      message: { ...current.message, [target.sessionID]: messages },
      part: { ...current.part, [input.message.id]: filterIdentifiedParts(input.parts) },
    })
  }

  optimisticRemove(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    const entry = this.getEntry(target)
    entry.optimistic.delete(input.messageID)
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const existing = current.message[target.sessionID]
    const messages = existing ? existing.filter((message) => message.id !== input.messageID) : undefined
    const part = { ...current.part }
    delete part[input.messageID]
    store.setState({
      ...(messages ? { message: { ...current.message, [target.sessionID]: messages } } : {}),
      part,
    })
  }

  optimisticConfirm(input: SessionMessageTarget & { messageID: string }): void {
    const target = this.normalizeTarget(input)
    if (!target) return
    this.getEntry(target).optimistic.delete(input.messageID)
  }

  /** Revert commits preserve only the optimistic records still in the reduced transcript. */
  invalidateSession(target: SessionMessageTarget, preservedMessages: readonly Message[] = []): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return
    clearSessionPrefetch(normalized.directory, [normalized.sessionID], this.runtimeKey)
    const entry = this.entries.get(this.keyFor(normalized))
    if (!entry) return
    this.bumpGeneration(entry)
    entry.inflight = null
    const preservedIDs = new Set(preservedMessages.map((message) => message.id))
    for (const messageID of entry.optimistic.keys()) {
      if (!preservedIDs.has(messageID)) entry.optimistic.delete(messageID)
    }
    entry.snapshot = createDefaultState(entry.snapshot.generation)
    this.notify(entry)
  }

  invalidateDirectory(directory: string): void {
    const normalizedDirectory = normalizePath(directory)
    if (!normalizedDirectory) return
    const prefix = `${this.runtimeKey}\n${normalizedDirectory}\n`
    clearDirectorySessionPrefetch(normalizedDirectory, this.runtimeKey)
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.entries.delete(key)
      this.notify(entry)
    }
  }

  dispose(): void {
    this.disposed = true
    this.retention?.dispose()
    this.retention = null
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.notify(entry)
    }
    this.entries.clear()
    clearRuntimeSessionPrefetch(this.runtimeKey)
  }

  private normalizeTarget(target: SessionMessageTarget): SessionMessageTarget | null {
    const directory = normalizePath(target.directory)
    if (!directory || !target.sessionID) return null
    return { directory, sessionID: target.sessionID }
  }

  private keyFor(target: SessionMessageTarget): string {
    return `${this.runtimeKey}\n${target.directory}\n${target.sessionID}`
  }

  private getEntry(target: SessionMessageTarget): LoaderEntry {
    const key = this.keyFor(target)
    const existing = this.entries.get(key)
    if (existing) return existing
    const prefetched = getSessionPrefetch(target.directory, target.sessionID, this.runtimeKey)
    const entry: LoaderEntry = {
      target: { directory: target.directory, sessionID: target.sessionID },
      snapshot: prefetched
        ? {
            ...createDefaultState(),
            status: "ready",
            resolved: true,
            limit: prefetched.limit,
            cursor: prefetched.cursor,
            complete: prefetched.complete,
            updatedAt: prefetched.at,
          }
        : createDefaultState(),
      listeners: new Set(),
      inflight: null,
      queuedRefresh: null,
      queuedRefreshLimit: 0,
      optimistic: new Map(),
      evicted: false,
      // Unknown provenance: confirmed only as of the loader's first epoch.
      verifiedEpoch: 0,
      gapAnchorID: null,
    }
    this.entries.set(key, entry)
    return entry
  }

  private patchEntry(entry: LoaderEntry, patch: Partial<SessionMessageLoadState>): void {
    entry.snapshot = { ...entry.snapshot, ...patch }
    this.notify(entry)
  }

  private bumpGeneration(entry: LoaderEntry): number {
    const generation = entry.snapshot.generation + 1
    entry.snapshot = { ...entry.snapshot, generation }
    return generation
  }

  private notify(entry: LoaderEntry): void {
    for (const listener of entry.listeners) listener()
  }

  private startLoad(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    kind: SessionMessageLoadKind,
    run: (isCurrent: () => boolean, performance: LoadPerformanceDetails) => Promise<void>,
  ): Promise<void> {
    const generation = entry.snapshot.generation
    const sdkEpoch = this.sdkEpoch
    const finishPerformanceEvent = startSessionLoadPerformanceEvent({
      operation: kind === "prefetch" ? "session-prefetch" : `session-messages.${kind}`,
      caller: kind,
    })
    const isCurrent = () => (
      !this.disposed
      && this.sdkEpoch === sdkEpoch
      && entry.snapshot.generation === generation
      && this.childStores.getChild(target.directory) === store
    )
    const performance = { retryCount: 0, recordCount: 0 }
    this.patchEntry(entry, { status: "loading", loadingKind: kind, error: null })
    let loadPromise: Promise<void>
    try {
      loadPromise = run(isCurrent, performance)
    } catch (error) {
      loadPromise = Promise.reject(error)
    }
    const promise = loadPromise
      .then(() => finishPerformanceEvent(isCurrent() ? "complete" : "stale", performance))
      .catch((error: unknown) => {
        if (!isCurrent()) {
          finishPerformanceEvent("stale", performance)
          return
        }
        finishPerformanceEvent("error", performance)
        this.patchEntry(entry, {
          status: "error",
          loadingKind: null,
          error: toLoadError(error),
        })
      })
      .finally(() => {
        if (entry.inflight === promise) entry.inflight = null
        this.scheduleCacheRetention(target.directory)
      })
    entry.inflight = promise
    return promise
  }

  private async loadInitial(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    isCurrent: () => boolean,
    performance?: LoadPerformanceDetails,
  ): Promise<void> {
    const epoch = this.historyEpoch
    const storeMessageCount = store.getState().message[target.sessionID]?.length ?? 0
    // Cold navigation aims for several whole turns; history readers and
    // sessions that already hold messages only need one user boundary.
    const coldNavigation = (storeMessageCount === 0 || entry.evicted) && !this.historyReaders.get(this.keyFor(target))
    const firstLimit = Math.max(entry.snapshot.limit, storeMessageCount, getInitialPageSize())
    const firstPage = await this.fetchPage(target, firstLimit, undefined, "initial-page", performance)
    if (!isCurrent()) return
    const acceptedPage = await this.extendWindow(target, firstPage, coldNavigation
      ? { isSatisfied: (window) => hasInitialTurns(window.session), targetTurns: INITIAL_USER_TURNS }
      : { isSatisfied: (window) => hasUserMessage(window.session), targetTurns: 1 }, isCurrent, performance)
    if (!acceptedPage) return

    // Publish the chosen window once.
    const committed = this.commitPage(target, entry, store, acceptedPage, "merge", isCurrent)
    if (!committed || !isCurrent()) return
    entry.evicted = false
    entry.verifiedEpoch = Math.max(entry.verifiedEpoch, epoch)
    this.patchEntry(entry, {
      status: "ready",
      loadingKind: null,
      error: null,
      resolved: true,
      limit: committed.messages.length,
      cursor: acceptedPage.cursor,
      complete: acceptedPage.complete,
      updatedAt: Date.now(),
    })
    this.persistCoverage(target, entry.snapshot)
  }

  /**
   * Extends a newest-first window backward through the server cursor until
   * `isSatisfied` holds, history is complete, or the window reaches the record
   * ceiling. The ceiling never stops it before the newest prompt: a window
   * without one has no turn to render. Each extension page is sized from the
   * turn density fetched so far, so a long session needs one more round trip,
   * not one per hundred records. Returns null when the read went stale.
   */
  private async extendWindow(
    target: SessionMessageTarget,
    firstPage: FetchedPage,
    goal: { isSatisfied: (window: FetchedPage) => boolean; targetTurns: number },
    isCurrent: () => boolean,
    performance?: LoadPerformanceDetails,
  ): Promise<FetchedPage | null> {
    let window = firstPage
    const visited = new Set<string>()
    while (!window.complete && !goal.isSatisfied(window)) {
      const held = window.session.length
      const turns = countUserMessages(window.session)
      const remaining = getInitialWindowMaxRecords() - held
      if (turns > 0 && remaining <= 0) break
      const cursor = window.cursor
      if (!cursor || visited.has(cursor)) break
      visited.add(cursor)
      const estimate = turns > 0
        ? Math.ceil((held * goal.targetTurns * EXTENSION_ESTIMATE_HEADROOM) / turns) - held
        : MAX_MESSAGE_PAGE_SIZE
      const limit = turns > 0 ? Math.max(1, Math.min(estimate, remaining)) : estimate
      const older = await this.fetchPage(target, limit, cursor, "initial-page", performance)
      if (!isCurrent()) return null
      if (older.session.length === 0 && !older.complete) break
      window = {
        session: [...older.session, ...window.session],
        partsByMessageID: new Map([...window.partsByMessageID, ...older.partsByMessageID]),
        cursor: older.cursor,
        complete: older.complete,
      }
    }
    return window
  }

  /**
   * One page of messages, newest first. `cursor` comes from the previous
   * page's `next` and walks toward older history; its absence is the adapter
   * saying this is the oldest page, which is the only signal for `complete`.
   */
  private async fetchPage(
    target: SessionMessageTarget,
    requestedLimit: number,
    cursor?: string,
    caller: "initial-page" | "older" | "refresh" = "initial-page",
    performance?: LoadPerformanceDetails,
  ): Promise<FetchedPage> {
    const limit = Math.min(Math.max(1, requestedLimit), MAX_MESSAGE_PAGE_SIZE)
    const finishPagePerformance = startSessionLoadPerformanceEvent({
      operation: "session-messages.page",
      caller,
      requestLimit: limit,
      cursorPresent: cursor !== undefined,
    })
    let attempts = 0
    let recordCount = 0
    try {
      const page = await retry(async () => {
        attempts += 1
        return this.sdk.getSessionMessages(target.sessionID, { limit, cursor }, target.directory)
      })
      const records = page.items.filter((record) => Boolean(record?.info?.id))
      recordCount = records.length
      if (performance) performance.recordCount += recordCount
      const session = sortMessagesChronologically(records.map((record) => record.info))
      const partsByMessageID = new Map<string, Part[]>()
      for (const record of records) {
        partsByMessageID.set(record.info.id, filterIdentifiedParts(record.parts ?? []))
      }
      const nextCursor = page.cursor?.next
      finishPagePerformance("complete", { retryCount: Math.max(0, attempts - 1), recordCount })
      return { session, partsByMessageID, cursor: nextCursor, complete: !nextCursor }
    } catch (error) {
      finishPagePerformance("error", { retryCount: Math.max(0, attempts - 1), recordCount })
      throw error
    } finally {
      if (performance) performance.retryCount += Math.max(0, attempts - 1)
    }
  }

  private commitPage(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    page: FetchedPage,
    mode: "merge" | "prepend" | "replace",
    isCurrent: () => boolean,
  ): { messages: Message[] } | null {
    if (!isCurrent()) return null
    const current = store.getState()
    const echoed = withoutEchoedOptimisticRecords(current, target.sessionID, page, entry.optimistic)
    const state = mode === "replace" ? withoutHistoryOutsideWindow(echoed, target.sessionID, page, entry.optimistic) : echoed
    const merged = mergeOptimisticPage({
      session: page.session,
      part: [...page.partsByMessageID].map(([id, part]) => ({ id, part })),
      cursor: page.cursor,
      complete: page.complete,
    }, [...entry.optimistic.values()])
    for (const messageID of merged.confirmed) entry.optimistic.delete(messageID)
    const mergedPartsByMessageID = new Map(merged.part.map((candidate) => [candidate.id, candidate.part] as const))
    const materialized = materializeSessionSnapshots(
      state,
      target.sessionID,
      merged.session.map((info) => ({
        info,
        parts: page.partsByMessageID.get(info.id)
          ?? mergedPartsByMessageID.get(info.id)
          ?? [],
      })),
      { mode: mode === "prepend" ? "prepend" : "merge" },
    )
    if (!isCurrent()) return null
    // Records the page made redundant were removed before materializing;
    // that removal is a change even when the page itself changes nothing.
    const messagesChanged = materialized.messagesChanged || state.message !== current.message
    const partsChanged = materialized.partsChanged || state.part !== current.part
    if (messagesChanged || partsChanged) {
      store.setState({
        ...(messagesChanged ? { message: materialized.message } : {}),
        ...(partsChanged ? { part: materialized.part } : {}),
      })
    }
    return { messages: materialized.messages }
  }

  private persistCoverage(target: SessionMessageTarget, state: SessionMessageLoadState): void {
    setSessionPrefetch({
      directory: target.directory,
      sessionID: target.sessionID,
      limit: state.limit,
      cursor: state.cursor,
      complete: state.complete,
      at: state.updatedAt,
      runtimeKey: this.runtimeKey,
    })
  }
}

type DirectoryStoreSetter = (
  partial: Partial<DirectoryStore> | ((state: DirectoryStore) => Partial<DirectoryStore> | DirectoryStore),
) => void

let imperativeLoader: SessionMessageLoader | null = null

export function setImperativeSessionMessageLoader(loader: SessionMessageLoader | null): void {
  imperativeLoader = loader
}

export function getImperativeSessionMessageLoader(): SessionMessageLoader | null {
  return imperativeLoader
}
