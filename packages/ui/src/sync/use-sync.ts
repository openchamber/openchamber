import { useCallback, useRef, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT, type State } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  mergeOptimisticPage,
  type OptimisticItem,
} from "./optimistic"
import { dropCachedSessionMessageRecordsSnapshots, useDirectoryStore, useSyncSDK, useSyncDirectory, useChildStoreManager } from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import {
  shouldSkipSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
  clearSessionPrefetch,
} from "./session-prefetch-cache"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"
import { sessionLoadDebug } from "./session-load-debug"
import { loadSessionMessagePage } from "./session-message-loader"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { sessionSyncCoordinator } from "./session-sync-coordinator"
import { loadSessionChildrenOnDemand, mergeSessionChildren } from "./session-children"
import { opencodeClient } from "@/lib/opencode/client"
import { waitForSessionStartupBarrier } from "@/lib/session-startup-barrier"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const INITIAL_MESSAGE_PAGE_SIZE = 30
const VSCODE_INITIAL_MESSAGE_PAGE_SIZE = 30
const MOBILE_INITIAL_MESSAGE_PAGE_SIZE = 30
const HISTORY_MESSAGE_PAGE_SIZE = 100
const MAX_SEEN_DIRS = 30
const VSCODE_SESSION_CACHE_LIMIT = 4
const MOBILE_SESSION_CACHE_LIMIT = 4
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Shared across useSync() instances so cache eviction is based on app-level
// session recency, not whichever component happened to call sync first.
const seenByDirectory = new Map<string, Set<string>>()

type SyncMeta = {
  limit: number
  cursor: string | undefined
  complete: boolean
  loading: boolean
}

type SdkResult<T> = {
  data?: T
  error?: unknown
  response?: {
    status?: number
    headers?: { get?: (name: string) => string | null }
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function assertSdkSuccess<T>(result: SdkResult<T>, operation: string): void {
  if (!result.error) return
  const status = result.response?.status
  throw new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`)
}

const isConstrainedSessionRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getEffectiveSessionCacheLimit = () => {
  if (isVSCodeRuntime()) return VSCODE_SESSION_CACHE_LIMIT
  if (isMobileSurfaceRuntime()) return MOBILE_SESSION_CACHE_LIMIT
  return SESSION_CACHE_LIMIT
}
const getInitialMessagePageSize = () => {
  if (isVSCodeRuntime()) return VSCODE_INITIAL_MESSAGE_PAGE_SIZE
  if (isMobileSurfaceRuntime()) return MOBILE_INITIAL_MESSAGE_PAGE_SIZE
  return INITIAL_MESSAGE_PAGE_SIZE
}
const getDefaultMeta = (): SyncMeta => ({ limit: getInitialMessagePageSize(), cursor: undefined, complete: false, loading: false })

function getPrefetchMeta(directory: string, sessionID: string): SyncMeta | undefined {
  const info = getSessionPrefetch(directory, sessionID)
  if (!info) return undefined
  return {
    limit: info.limit,
    cursor: info.cursor,
    complete: info.complete,
    loading: false,
  }
}

function sortParts(parts: Part[]) {
  return parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
}

function isHeavyConstrainedSessionCache(state: Pick<State, "message" | "part">, sessionID: string): boolean {
  const messages = state.message[sessionID]
  if (!messages || messages.length === 0) return false
  return messages.length > getInitialMessagePageSize()
}

export function shouldFetchSessionForRenderableSync(input: {
  hasSession: boolean
  shouldLoadMessages: boolean
  force?: boolean
}): boolean {
  return Boolean(input.force) || !input.hasSession || input.shouldLoadMessages
}

// ---------------------------------------------------------------------------
// useSync — message loading, pagination, optimistic updates
// Message loading, pagination, optimistic updates
// ---------------------------------------------------------------------------

export function useSync() {
  const sdk = useSyncSDK()
  const directory = useSyncDirectory()
  const store = useDirectoryStore()
  const childStores = useChildStoreManager()

  // Refs for mutable tracking (no re-renders)
  const optimistic = useRef(new Map<string, Map<string, OptimisticItem>>())
  const meta = useRef(new Map<string, SyncMeta>())

  const keyFor = useCallback(
    (sessionID: string) => `${directory}\n${sessionID}`,
    [directory],
  )

  const getMetaFor = useCallback(
    (sessionID: string) => {
      const key = keyFor(sessionID)
      return meta.current.get(key) ?? getPrefetchMeta(directory, sessionID) ?? getDefaultMeta()
    },
    [directory, keyFor],
  )

  const setMetaFor = useCallback(
    (sessionID: string, patch: Partial<{ limit: number; cursor: string | undefined; complete: boolean; loading: boolean }>) => {
      const key = keyFor(sessionID)
      const current = meta.current.get(key) ?? getPrefetchMeta(directory, sessionID) ?? getDefaultMeta()
      meta.current.set(key, { ...current, ...patch })
    },
    [directory, keyFor],
  )

  // Session cache eviction — two levels of LRU:
  // (1) across directories (max 30), (2) within a directory (SESSION_CACHE_LIMIT).

  // Evict all cached session data for given IDs from a directory's store
  const evict = useCallback(
    (dir: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      const dirStore = childStores.getChild(dir)
      if (!dirStore) return

      const current = dirStore.getState()
      const draft = {
        message: { ...current.message },
        part: { ...current.part },
        session_status: { ...current.session_status },
        session_diff: { ...current.session_diff },
        todo: { ...current.todo },
        permission: { ...current.permission },
        question: { ...current.question },
      }
      dropSessionCaches(draft, sessionIDs)
      dropCachedSessionMessageRecordsSnapshots(dirStore, sessionIDs)
      dirStore.setState(draft)

      // Clear meta + optimistic + prefetch cache for evicted sessions
      for (const id of sessionIDs) {
        optimistic.current.delete(`${dir}\n${id}`)
        meta.current.delete(`${dir}\n${id}`)
      }
      clearSessionPrefetch(dir, sessionIDs)
    },
    [childStores],
  )

  // Get or create the seen-set for a directory. LRU reorder on access.
  // When seen directories exceed MAX_SEEN_DIRS, evict the oldest directory's caches.
  // LRU reorder on access. Evicts oldest directory when exceeding MAX_SEEN_DIRS.
  const seenFor = useCallback(() => {
    const existing = seenByDirectory.get(directory)
    if (existing) {
      // LRU reorder: delete + re-insert moves to end (most recent)
      seenByDirectory.delete(directory)
      seenByDirectory.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seenByDirectory.set(directory, created)

    // Evict oldest directories if over limit
    while (seenByDirectory.size > MAX_SEEN_DIRS) {
      const first = seenByDirectory.keys().next().value
      if (!first) break
      const staleSessionIds = [...(seenByDirectory.get(first) ?? [])]
      seenByDirectory.delete(first)
      evict(first, staleSessionIds)
    }

    return created
  }, [directory, evict])

  // Touch a session — triggers both directory-level and session-level eviction
  const touch = useCallback(
    (sessionID: string) => {
      const s = seenFor()
      const protectedIds = getProtectedSessionCacheIds(store.getState())
      const cacheLimit = getEffectiveSessionCacheLimit()
      const stale = pickSessionCacheEvictions({
        seen: s,
        keep: sessionID,
        limit: cacheLimit,
        preserve: protectedIds,
      })
      evict(directory, stale)

      if (isConstrainedSessionRuntime()) {
        const state = store.getState()
        const keep = new Set([sessionID, ...s, ...protectedIds])
        const prefetched = Object.keys(state.message).filter((id) => !keep.has(id))
        evict(directory, prefetched)

        // One very large inactive session can create memory/GC pressure that
        // makes later small-session switches feel slow. Keep it while active,
        // but do not retain it as a warm cache in constrained shells.
        const afterPrefetchEviction = prefetched.length > 0 ? store.getState() : state
        const heavyInactive = Object.keys(afterPrefetchEviction.message).filter((id) => {
          if (id === sessionID || protectedIds.has(id)) return false
          return isHeavyConstrainedSessionCache(afterPrefetchEviction, id)
        })
        if (heavyInactive.length > 0) {
          for (const id of heavyInactive) s.delete(id)
          evict(directory, heavyInactive)
        }
      }
    },
    [directory, seenFor, evict, store],
  )

  // Optimistic operations
  const getOptimistic = useCallback(
    (sessionID: string, directoryOverride?: string | null): OptimisticItem[] => {
      const key = `${directoryOverride || directory}\n${sessionID}`
      return [...(optimistic.current.get(key)?.values() ?? [])]
    },
    [directory],
  )

  const setOptimistic = useCallback(
    (sessionID: string, item: OptimisticItem, directoryOverride?: string | null) => {
      const key = `${directoryOverride || directory}\n${sessionID}`
      const list = optimistic.current.get(key)
      const sorted: OptimisticItem = { message: item.message, parts: sortParts(item.parts) }
      if (list) {
        list.set(item.message.id, sorted)
      } else {
        optimistic.current.set(key, new Map([[item.message.id, sorted]]))
      }
    },
    [directory],
  )

  const clearOptimistic = useCallback(
    (sessionID: string, messageID?: string, directoryOverride?: string | null) => {
      const key = `${directoryOverride || directory}\n${sessionID}`
      if (!messageID) {
        optimistic.current.delete(key)
        return
      }
      const list = optimistic.current.get(key)
      if (!list) return
      list.delete(messageID)
      if (list.size === 0) optimistic.current.delete(key)
    },
    [directory],
  )

  const getOptimisticStore = useCallback(
    (directoryOverride?: string | null) => {
      if (!directoryOverride || directoryOverride === directory) return store
      return childStores.ensureChild(directoryOverride, { bootstrap: false })
    },
    [childStores, directory, store],
  )

  // Fetch messages from API
  const fetchMessages = useCallback(
    async (sessionID: string, limit: number, before?: string) => {
      const startedAt = performance.now()
      sessionLoadDebug("reactive-request-start", { sessionID, directory, limit, before: before ?? null })
      const result = await loadSessionMessagePage({
        runtimeKey: getRuntimeKey(),
        directory,
        sessionID,
        before,
        request: () => retry(async () => {
          const response = await sdk.session.messages({ sessionID, directory, limit, before })
          assertSdkSuccess(response, "session.messages")
          return response
        }),
      })
      const items = (result.data ?? []).filter((x: { info?: { id?: string } }) => !!x?.info?.id)
      const session = items
        .map((x: { info: Message }) => stripMessageDiffSnapshots(x.info))
        .sort((a: Message, b: Message) => cmp(a.id, b.id))
      const part = items.map((x: { info: { id: string }; parts: Part[] }) => ({
        id: x.info.id,
        part: sortParts(x.parts),
      }))
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      sessionLoadDebug("reactive-request-response", {
        sessionID,
        directory,
        limit,
        before: before ?? null,
        records: session.length,
        hasCursor: Boolean(cursor),
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      })
      return { session, part, cursor, complete: !cursor }
    },
    [sdk, directory],
  )

  // Load messages for a session
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; mode?: "replace" | "prepend"; isStale?: () => boolean }) => {
      const m = getMetaFor(sessionID)
      if (m.loading) {
        sessionLoadDebug("reactive-load-deduped", { sessionID, directory, before: options?.before ?? null })
        return
      }
      setMetaFor(sessionID, { loading: true })
      const startedAt = performance.now()

      try {
        // A resync (no `before`) must fetch at least as many messages as we
        // already have on screen. Live events append to the store WITHOUT growing
        // m.limit, so reusing the stale m.limit here would under-fetch and make
        // the server hand back a spurious "older" cursor — surfacing a phantom
        // "load older" button for a session whose full history is already shown
        // (e.g. after a reconnect resync following a few new messages).
        const storeMessageCount = store.getState().message[sessionID]?.length ?? 0
        const limit = options?.before ? HISTORY_MESSAGE_PAGE_SIZE : Math.max(m.limit, storeMessageCount)
        const page = await fetchMessages(sessionID, limit, options?.before)

        // Merge optimistic items
        const items = getOptimistic(sessionID)
        const merged = mergeOptimisticPage(page, items)
        for (const messageID of merged.confirmed) {
          clearOptimistic(sessionID, messageID)
        }

        if (options?.isStale?.()) {
          setMetaFor(sessionID, { loading: false })
          return
        }

        const current = store.getState()
        const materialized = materializeSessionSnapshots(
          current,
          sessionID,
          merged.session.map((info) => ({
            info,
            parts: merged.part.find((item) => item.id === info.id)?.part ?? [],
          })),
          { skipPartTypes: SKIP_PARTS, mode: options?.mode === "prepend" ? "prepend" : "merge" },
        )

        if (options?.isStale?.()) {
          setMetaFor(sessionID, { loading: false })
          return
        }

        setMetaFor(sessionID, {
          limit: materialized.messages.length,
          cursor: merged.cursor,
          complete: merged.complete,
          loading: false,
        })
        if (materialized.messagesChanged || materialized.partsChanged) {
          store.setState({
            ...(materialized.messagesChanged ? { message: materialized.message } : {}),
            ...(materialized.partsChanged ? { part: materialized.part } : {}),
          })
        }
        sessionLoadDebug("reactive-committed", {
          sessionID,
          directory,
          messages: materialized.messages.length,
          mode: options?.mode ?? "replace",
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        })
        setSessionPrefetch({
          directory,
          sessionID,
          limit: materialized.messages.length,
          cursor: merged.cursor,
          complete: merged.complete,
        })
      } catch (error) {
        sessionLoadDebug("reactive-error", {
          sessionID,
          directory,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          error: error instanceof Error ? error.message : String(error),
        })
        setMetaFor(sessionID, { loading: false })
      }
    },
    [store, fetchMessages, getMetaFor, setMetaFor, getOptimistic, clearOptimistic, directory],
  )

  // Sync a session (load if not cached)
  const syncSession = useCallback(
    async (sessionID: string, force?: boolean) => {
      await waitForSessionStartupBarrier()
      touch(sessionID)
      const key = keyFor(sessionID)
      return sessionSyncCoordinator.run({
        scope: store,
        key,
        request: async (isStale) => {
          const current = store.getState()
          const m = getMetaFor(sessionID)
          const materialization = getSessionMaterializationStatus(current, sessionID)
          const cached = materialization.hasMessages && materialization.renderable && m.limit > 0
          const prefetchInfo = !force ? getSessionPrefetch(directory, sessionID) : undefined
          const cachedReady = cached
          const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
          if (cachedReady && hasSession && !force) return

          // Skip if recently fetched (TTL)
          if (!force && shouldSkipSessionPrefetch({
            hasMessages: cachedReady,
            info: prefetchInfo,
            pageSize: getInitialMessagePageSize(),
          })) return

          const shouldLoadMessages = Boolean(!cachedReady || force)
          const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
          sessionLoadDebug("reactive-sync-decision", {
            sessionID,
            directory,
            cached,
            cachedReady,
            hasSession,
            shouldLoadMessages,
            shouldFetchSession,
            force: Boolean(force),
          })
          await Promise.all([
            shouldFetchSession
              ? (async () => {
                  try {
                    const result = await retry(async () => {
                      const response = await sdk.session.get({ sessionID, directory })
                      assertSdkSuccess(response, "session.get")
                      return response
                    })
                    if (result.data && !isStale()) {
                      const nextSession = stripSessionDiffSnapshots(result.data)
                      const s = store.getState()
                      const sessions = [...s.session]
                      const idx = Binary.search(sessions, sessionID, (s) => s.id)
                      if (idx.found) {
                        sessions[idx.index] = nextSession
                      } else {
                        sessions.splice(idx.index, 0, nextSession)
                      }
                      if (!isStale()) {
                        store.setState({ session: sessions })
                      }
                    }
                  } catch (e) {
                    console.error("[sync] failed to fetch session", sessionID, e)
                  }
                })()
              : Promise.resolve(),
            shouldLoadMessages ? loadMessages(sessionID, { isStale }) : Promise.resolve(),
          ])
        },
      })
    },
    [store, sdk, keyFor, touch, getMetaFor, loadMessages, directory],
  )

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string) => {
      touch(sessionID)
      const m = getMetaFor(sessionID)
      if (m.loading || m.complete || !m.cursor) return
      await loadMessages(sessionID, { before: m.cursor, mode: "prepend" })
    },
    [touch, getMetaFor, loadMessages],
  )

  const loadChildren = useCallback(
    async (sessionID: string, directoryOverride?: string | null) => {
      const targetDirectory = directoryOverride || directory
      if (!sessionID || !targetDirectory) return
      const targetStore = childStores.ensureChild(targetDirectory, { bootstrap: false })
      const scopedClient = opencodeClient.getScopedSdkClient(targetDirectory)
      const incoming = await loadSessionChildrenOnDemand({
        runtimeKey: getRuntimeKey(),
        directory: targetDirectory,
        sessionID,
        request: async () => {
          const response = await scopedClient.session.children({ sessionID, directory: targetDirectory })
          assertSdkSuccess(response, "session.children")
          return (response.data ?? []) as import('@opencode-ai/sdk/v2').Session[]
        },
      })
      targetStore.setState((state) => {
        const sessions = mergeSessionChildren(state.session, incoming, sessionID)
        if (sessions === state.session) return state
        return { session: sessions, limit: Math.max(state.limit, sessions.length) }
      })
    },
    [childStores, directory],
  )

  const hasMore = useCallback(
    (sessionID: string) => {
      const m = getMetaFor(sessionID)
      return !m.complete && !!m.cursor
    },
    [getMetaFor],
  )

  const isLoading = useCallback(
    (sessionID: string) => getMetaFor(sessionID).loading,
    [getMetaFor],
  )

  // True only when a fetch has positively confirmed the history is fully
  // loaded (no next cursor). Distinct from !hasMore(), which is also true for
  // sessions whose meta simply hasn't been populated yet.
  const isComplete = useCallback(
    (sessionID: string) => getMetaFor(sessionID).complete,
    [getMetaFor],
  )

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; directory?: string | null; message: Message; parts: Part[] }) => {
      setOptimistic(input.sessionID, { message: input.message, parts: input.parts }, input.directory)
      const targetStore = getOptimisticStore(input.directory)
      const current = targetStore.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      // Insert message
      const messages = message[input.sessionID] ? [...message[input.sessionID]] : []
      const result = Binary.search(messages, input.message.id, (m) => m.id)
      if (!result.found) messages.splice(result.index, 0, input.message)
      message[input.sessionID] = messages

      // Insert parts
      part[input.message.id] = sortParts(input.parts)

      targetStore.setState({ message, part })
    },
    [getOptimisticStore, setOptimistic],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      clearOptimistic(input.sessionID, input.messageID, input.directory)
      const targetStore = getOptimisticStore(input.directory)
      const current = targetStore.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      const messages = message[input.sessionID]
      if (messages) {
        const next = [...messages]
        const result = Binary.search(next, input.messageID, (m) => m.id)
        if (result.found) {
          next.splice(result.index, 1)
          message[input.sessionID] = next
        }
      }
      delete part[input.messageID]

      targetStore.setState({ message, part })
    },
    [clearOptimistic, getOptimisticStore],
  )

  const optimisticConfirm = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      clearOptimistic(input.sessionID, input.messageID, input.directory)
    },
    [clearOptimistic],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      loadChildren,
      loadMore,
      hasMore,
      isLoading,
      isComplete,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
        confirm: optimisticConfirm,
      },
    }),
    [syncSession, loadChildren, loadMore, hasMore, isLoading, isComplete, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}
