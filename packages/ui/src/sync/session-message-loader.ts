import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import type { ChildStoreManager, DirectoryStore } from "./child-store"
import { Binary } from "./binary"
import { retry } from "./retry"
import { mergeOptimisticPage, type OptimisticItem } from "./optimistic"
import { stripMessageDiffSnapshots } from "./sanitize"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { clearSessionPrefetch, getSessionPrefetch, setSessionPrefetch } from "./session-prefetch-cache"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { normalizePath } from "@/lib/pathNormalization"
import { startSessionLoadPerformanceEvent } from "./session-load-performance"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const INITIAL_MESSAGE_PAGE_SIZE = 50
const CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE = 30
const HISTORY_MESSAGE_PAGE_SIZE = 100
const INITIAL_PAGE_EXPANSION_LIMITS = [100, 150] as const
const CONSTRAINED_INITIAL_PAGE_EXPANSION_LIMITS = [50, 80, 120] as const
const cmp = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

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
  snapshot: SessionMessageLoadState
  listeners: Set<() => void>
  inflight: Promise<void> | null
  optimistic: Map<string, OptimisticItem>
}

type FetchedPage = {
  session: Message[]
  partsByMessageID: Map<string, Part[]>
  cursor: string | undefined
  complete: boolean
}

type LoaderConfiguration = {
  sdk: OpencodeClient
  runtimeKey: string
}

const isConstrainedRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getInitialPageSize = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_MESSAGE_PAGE_SIZE
  : INITIAL_MESSAGE_PAGE_SIZE
const getInitialExpansionLimits = () => isConstrainedRuntime()
  ? CONSTRAINED_INITIAL_PAGE_EXPANSION_LIMITS
  : INITIAL_PAGE_EXPANSION_LIMITS

const isUserMessage = (message: Message): boolean => {
  const candidate = message as Message & { clientRole?: unknown; role?: unknown }
  const role = typeof candidate.clientRole === "string" ? candidate.clientRole : candidate.role
  return role === "user"
}

const hasUserMessage = (messages: Message[]): boolean => messages.some(isUserMessage)

const formatSdkError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return "Session messages could not be loaded"
}

const assertSdkSuccess = (result: {
  error?: unknown
  response?: { status?: number }
}, operation: string): void => {
  if (!result.error) return
  const status = result.response?.status
  throw new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`)
}

const sortParts = (parts: Part[]): Part[] => parts
  .filter((part) => Boolean(part?.id))
  .sort((left, right) => cmp(left.id, right.id))

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
  private sdk: OpencodeClient
  private runtimeKey: string
  private sdkEpoch = 0
  private disposed = false
  private readonly entries = new Map<string, LoaderEntry>()

  constructor(
    private readonly childStores: ChildStoreManager,
    configuration: LoaderConfiguration,
  ) {
    this.sdk = configuration.sdk
    this.runtimeKey = configuration.runtimeKey
  }

  configure(configuration: LoaderConfiguration): void {
    if (this.sdk === configuration.sdk && this.runtimeKey === configuration.runtimeKey) return
    const runtimeChanged = this.runtimeKey !== configuration.runtimeKey
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
    }
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
    if (!options?.force && materialization.renderable) {
      if (!entry.snapshot.resolved) {
        this.patchEntry(entry, {
          status: "ready",
          error: null,
          resolved: true,
          limit: Math.max(entry.snapshot.limit, store.getState().message[normalized.sessionID]?.length ?? 0),
        })
      }
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
    return this.startLoad(normalized, entry, store, kind, async (isCurrent) => {
      await this.loadInitial(normalized, entry, store, isCurrent)
      if (!isMobileSurfaceRuntime() && isCurrent()) {
        queueMicrotask(() => {
          if (isCurrent() && entry.snapshot.cursor && !entry.snapshot.complete) {
            void this.loadOlder(normalized)
          }
        })
      }
    })
  }

  prefetch(target: SessionMessageTarget): Promise<void> {
    return this.ensure(target, { reason: "prefetch" })
  }

  loadOlder(target: SessionMessageTarget): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) return entry.inflight.then(() => this.loadOlder(normalized))
    if (entry.snapshot.complete || !entry.snapshot.cursor) return Promise.resolve()
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    const cursor = entry.snapshot.cursor
    return this.startLoad(normalized, entry, store, "older", async (isCurrent) => {
      const page = await this.fetchPage(normalized, HISTORY_MESSAGE_PAGE_SIZE, cursor)
      if (!isCurrent()) return
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

  refreshTail(target: SessionMessageTarget, limit: number): Promise<void> {
    const normalized = this.normalizeTarget(target)
    if (!normalized || this.disposed) return Promise.resolve()
    const entry = this.getEntry(normalized)
    if (entry.inflight) return entry.inflight
    const store = this.childStores.ensureChild(normalized.directory, { bootstrap: false })
    this.bumpGeneration(entry)
    return this.startLoad(normalized, entry, store, "refresh", async (isCurrent) => {
      const page = await this.fetchPage(normalized, Math.max(1, limit))
      if (!isCurrent()) return
      const committed = this.commitPage(normalized, entry, store, page, "merge", isCurrent)
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
    entry.optimistic.set(input.message.id, { message: input.message, parts: sortParts(input.parts) })
    const store = this.childStores.ensureChild(target.directory, { bootstrap: false })
    const current = store.getState()
    const messages = current.message[target.sessionID] ? [...current.message[target.sessionID]] : []
    const result = Binary.search(messages, input.message.id, (message) => message.id)
    if (!result.found) messages.splice(result.index, 0, input.message)
    store.setState({
      message: { ...current.message, [target.sessionID]: messages },
      part: { ...current.part, [input.message.id]: sortParts(input.parts) },
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

  invalidateSession(target: SessionMessageTarget): void {
    const normalized = this.normalizeTarget(target)
    if (!normalized) return
    const entry = this.entries.get(this.keyFor(normalized))
    if (!entry) return
    this.bumpGeneration(entry)
    entry.inflight = null
    entry.optimistic.clear()
    entry.snapshot = createDefaultState(entry.snapshot.generation)
    clearSessionPrefetch(normalized.directory, [normalized.sessionID])
    this.notify(entry)
  }

  invalidateDirectory(directory: string): void {
    const normalizedDirectory = normalizePath(directory)
    if (!normalizedDirectory) return
    const prefix = `${this.runtimeKey}\n${normalizedDirectory}\n`
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
    this.sdkEpoch += 1
    for (const entry of this.entries.values()) {
      this.bumpGeneration(entry)
      entry.inflight = null
      entry.optimistic.clear()
      this.notify(entry)
    }
    this.entries.clear()
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
    const prefetched = getSessionPrefetch(target.directory, target.sessionID)
    const entry: LoaderEntry = {
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
      optimistic: new Map(),
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
    run: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const generation = entry.snapshot.generation
    const sdkEpoch = this.sdkEpoch
    const finishPerformanceEvent = startSessionLoadPerformanceEvent({
      operation: kind === "prefetch" ? "session-prefetch" : `session-messages.${kind}`,
      runtimeKey: this.runtimeKey,
      directory: target.directory,
      sessionID: target.sessionID,
      caller: kind,
    })
    const isCurrent = () => (
      !this.disposed
      && this.sdkEpoch === sdkEpoch
      && entry.snapshot.generation === generation
      && this.childStores.getChild(target.directory) === store
    )
    this.patchEntry(entry, { status: "loading", loadingKind: kind, error: null })
    let loadPromise: Promise<void>
    try {
      loadPromise = run(isCurrent)
    } catch (error) {
      loadPromise = Promise.reject(error)
    }
    const promise = loadPromise
      .then(() => finishPerformanceEvent(isCurrent() ? "complete" : "stale"))
      .catch((error: unknown) => {
        if (!isCurrent()) {
          finishPerformanceEvent("stale")
          return
        }
        finishPerformanceEvent("error")
        this.patchEntry(entry, {
          status: "error",
          loadingKind: null,
          error: error instanceof Error ? error : new Error(formatSdkError(error)),
        })
      })
      .finally(() => {
        if (entry.inflight === promise) entry.inflight = null
      })
    entry.inflight = promise
    return promise
  }

  private async loadInitial(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    isCurrent: () => boolean,
  ): Promise<void> {
    const storeMessageCount = store.getState().message[target.sessionID]?.length ?? 0
    const firstLimit = Math.max(entry.snapshot.limit, storeMessageCount, getInitialPageSize())
    const firstPage = await this.fetchPage(target, firstLimit)
    if (!isCurrent()) return
    const deferFirstCommit = !firstPage.complete && !hasUserMessage(firstPage.session)
    let committed = deferFirstCommit
      ? { messages: firstPage.session }
      : this.commitPage(target, entry, store, firstPage, "merge", isCurrent)
    let acceptedPage = firstPage

    if (deferFirstCommit) {
      for (const limit of getInitialExpansionLimits()) {
        if (limit <= firstLimit || !isCurrent()) continue
        const expandedPage = await this.fetchPage(target, limit)
        if (!isCurrent()) return
        acceptedPage = expandedPage
        const boundaryFound = hasUserMessage(expandedPage.session)
        const isLast = limit === getInitialExpansionLimits()[getInitialExpansionLimits().length - 1]
        if (expandedPage.complete || boundaryFound || isLast) {
          committed = this.commitPage(target, entry, store, expandedPage, "merge", isCurrent)
        } else {
          committed = { messages: expandedPage.session }
        }
        if (expandedPage.complete || boundaryFound) break
      }
    }

    if (!committed || !isCurrent()) return
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

  private async fetchPage(target: SessionMessageTarget, limit: number, before?: string): Promise<FetchedPage> {
    const result = await retry(async () => {
      const response = await this.sdk.session.messages({
        sessionID: target.sessionID,
        directory: target.directory,
        limit,
        before,
      })
      assertSdkSuccess(response, "session.messages")
      if (!Array.isArray(response.data)) {
        const error = new Error("session.messages returned no data") as Error & { status?: number }
        error.status = 503
        throw error
      }
      return { data: response.data, response: response.response }
    })
    const records = result.data.filter((record: { info?: { id?: string } }) => Boolean(record?.info?.id))
    const session = records
      .map((record: { info: Message }) => stripMessageDiffSnapshots(record.info))
      .sort((left: Message, right: Message) => cmp(left.id, right.id))
    const partsByMessageID = new Map<string, Part[]>()
    for (const record of records as Array<{ info: { id: string }; parts?: Part[] }>) {
      partsByMessageID.set(record.info.id, sortParts(record.parts ?? []))
    }
    const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
    return { session, partsByMessageID, cursor, complete: !cursor }
  }

  private commitPage(
    target: SessionMessageTarget,
    entry: LoaderEntry,
    store: { getState: () => DirectoryStore; setState: DirectoryStoreSetter },
    page: FetchedPage,
    mode: "merge" | "prepend",
    isCurrent: () => boolean,
  ): { messages: Message[] } | null {
    if (!isCurrent()) return null
    const merged = mergeOptimisticPage({
      session: page.session,
      part: [...page.partsByMessageID].map(([id, part]) => ({ id, part })),
      cursor: page.cursor,
      complete: page.complete,
    }, [...entry.optimistic.values()])
    for (const messageID of merged.confirmed) entry.optimistic.delete(messageID)
    const mergedPartsByMessageID = new Map(merged.part.map((candidate) => [candidate.id, candidate.part] as const))
    const materialized = materializeSessionSnapshots(
      store.getState(),
      target.sessionID,
      merged.session.map((info) => ({
        info,
        parts: page.partsByMessageID.get(info.id)
          ?? mergedPartsByMessageID.get(info.id)
          ?? [],
      })),
      { skipPartTypes: SKIP_PARTS, mode },
    )
    if (!isCurrent()) return null
    if (materialized.messagesChanged || materialized.partsChanged) {
      store.setState({
        ...(materialized.messagesChanged ? { message: materialized.message } : {}),
        ...(materialized.partsChanged ? { part: materialized.part } : {}),
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
