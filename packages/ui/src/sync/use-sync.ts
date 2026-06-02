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
import { stripMessageDiffSnapshots } from "./sanitize"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import {
  shouldSkipSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
  clearSessionPrefetch,
} from "./session-prefetch-cache"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const INITIAL_MESSAGE_PAGE_SIZE = 150
const VSCODE_INITIAL_MESSAGE_PAGE_SIZE = 30
const MOBILE_INITIAL_MESSAGE_PAGE_SIZE = 30
const HISTORY_MESSAGE_PAGE_SIZE = 200
const VSCODE_INITIAL_PAGE_EXPANSION_LIMITS = [50, 80, 120] as const
const MAX_SEEN_DIRS = 30
const VSCODE_SESSION_CACHE_LIMIT = 4
const MOBILE_SESSION_CACHE_LIMIT = 4
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Shared across useSync() instances so cache eviction is based on app-level
// session recency, not whichever component happened to call sync first.
const seenByDirectory = new Map<string, Set<string>>()

// Shared across useSync() hook instances. Chat, model controls, and sidebar can
// all request the same session during startup; coalesce them into one HTTP load.
const syncSessionInflightByKey = new Map<string, Promise<void>>()

type SyncMeta = {
  limit: number
  cursor: string | undefined
  complete: boolean
  loading: boolean
}

const isConstrainedSessionRuntime = () => isVSCodeRuntime() || isMobileSurfaceRuntime()
const getConstrainedInitialPageExpansionMax = () => VSCODE_INITIAL_PAGE_EXPANSION_LIMITS[VSCODE_INITIAL_PAGE_EXPANSION_LIMITS.length - 1]
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

function isUserMessage(message: Message): boolean {
  const info = message as Message & { clientRole?: unknown; role?: unknown }
  const role = typeof info.clientRole === "string" ? info.clientRole : info.role
  return role === "user"
}

function hasUserMessage(messages: Message[] | undefined): boolean {
  return Boolean(messages?.some(isUserMessage))
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
    (sessionID: string): OptimisticItem[] => {
      const key = `${directory}\n${sessionID}`
      return [...(optimistic.current.get(key)?.values() ?? [])]
    },
    [directory],
  )

  const setOptimistic = useCallback(
    (sessionID: string, item: OptimisticItem) => {
      const key = `${directory}\n${sessionID}`
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
    (sessionID: string, messageID?: string) => {
      const key = `${directory}\n${sessionID}`
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

  // Fetch messages from API
  const fetchMessages = useCallback(
    async (sessionID: string, limit: number, before?: string) => {
      const result = await retry(() =>
        sdk.session.messages({ sessionID, directory, limit, before }),
      )
      const items = (result.data ?? []).filter((x: { info?: { id?: string } }) => !!x?.info?.id)
      const session = items
        .map((x: { info: Message }) => stripMessageDiffSnapshots(x.info))
        .sort((a: Message, b: Message) => cmp(a.id, b.id))
      const part = items.map((x: { info: { id: string }; parts: Part[] }) => ({
        id: x.info.id,
        part: sortParts(x.parts),
      }))
      const cursor = result.response?.headers?.get?.("x-next-cursor") ?? undefined
      return { session, part, cursor, complete: !cursor }
    },
    [sdk, directory],
  )

  // Load messages for a session
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; mode?: "replace" | "prepend" }) => {
      const m = getMetaFor(sessionID)
      if (m.loading) return
      setMetaFor(sessionID, { loading: true })

      try {
        const limit = options?.before ? HISTORY_MESSAGE_PAGE_SIZE : m.limit
        let page = await fetchMessages(sessionID, limit, options?.before)

        // Constrained shells keep the initial page small for switch performance. Some
        // sessions have a very large final turn, so the latest 30 records can
        // contain only assistant/tool records and no user boundary. That makes
        // turn projection render an empty chat until the user manually loads
        // older messages. Expand only this initial tail fetch, with a hard cap.
        if (!options?.before && isConstrainedSessionRuntime() && !page.complete && !hasUserMessage(page.session)) {
          for (const nextLimit of VSCODE_INITIAL_PAGE_EXPANSION_LIMITS) {
            if (nextLimit <= limit) continue
            page = await fetchMessages(sessionID, nextLimit)
            if (page.complete || hasUserMessage(page.session)) break
          }
        }

        // Merge optimistic items
        const items = getOptimistic(sessionID)
        const merged = mergeOptimisticPage(page, items)
        for (const messageID of merged.confirmed) {
          clearOptimistic(sessionID, messageID)
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

        setMetaFor(sessionID, {
          limit: materialized.messages.length,
          cursor: merged.cursor,
          complete: merged.complete,
          loading: false,
        })
        store.setState({ message: materialized.message, part: materialized.part })
        setSessionPrefetch({
          directory,
          sessionID,
          limit: materialized.messages.length,
          cursor: merged.cursor,
          complete: merged.complete,
        })
      } catch {
        setMetaFor(sessionID, { loading: false })
      }
    },
    [store, fetchMessages, getMetaFor, setMetaFor, getOptimistic, clearOptimistic, directory],
  )

  // Sync a session (load if not cached)
  const syncSession = useCallback(
    async (sessionID: string, force?: boolean) => {
      touch(sessionID)
      const key = keyFor(sessionID)

      // Dedup inflight requests
      const existing = syncSessionInflightByKey.get(key)
      if (existing) return existing

      const current = store.getState()
      const m = getMetaFor(sessionID)
      const materialization = getSessionMaterializationStatus(current, sessionID)
      const cached = materialization.hasMessages && materialization.renderable && m.limit > 0
      const prefetchInfo = !force ? getSessionPrefetch(directory, sessionID) : undefined
      const knownCachedLimit = Math.max(m.limit, prefetchInfo?.limit ?? 0)
      const needsConstrainedInitialTurnBoundary = isConstrainedSessionRuntime()
        && cached
        && !hasUserMessage(current.message[sessionID])
        && knownCachedLimit < getConstrainedInitialPageExpansionMax()
        && !m.complete
        && prefetchInfo?.complete !== true
        && Boolean(m.cursor ?? prefetchInfo?.cursor)
      if (needsConstrainedInitialTurnBoundary && prefetchInfo && prefetchInfo.limit > m.limit) {
        setMetaFor(sessionID, {
          limit: prefetchInfo.limit,
          cursor: prefetchInfo.cursor,
          complete: prefetchInfo.complete,
        })
      }
      const cachedReady = cached && !needsConstrainedInitialTurnBoundary
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cachedReady && hasSession && !force) return

      // Skip if recently fetched (TTL)
      if (!force && !needsConstrainedInitialTurnBoundary) {
        if (shouldSkipSessionPrefetch({
          hasMessages: cachedReady,
          info: prefetchInfo,
          pageSize: getInitialMessagePageSize(),
        })) return
      }

      const shouldFetchSession = !hasSession || force
      const shouldLoadMessages = !cachedReady || force
      const promise = (async () => {
        await Promise.all([
          shouldFetchSession
            ? (async () => {
                try {
                  const result = await retry(() => sdk.session.get({ sessionID, directory }))
                  if (result.data) {
                    const s = store.getState()
                    const sessions = [...s.session]
                    const idx = Binary.search(sessions, sessionID, (s) => s.id)
                    if (idx.found) {
                      sessions[idx.index] = result.data
                    } else {
                      sessions.splice(idx.index, 0, result.data)
                    }
                    store.setState({ session: sessions })
                  }
                } catch (e) {
                  console.error("[sync] failed to fetch session", sessionID, e)
                }
              })()
            : Promise.resolve(),
          shouldLoadMessages ? loadMessages(sessionID) : Promise.resolve(),
        ])
      })()

      syncSessionInflightByKey.set(key, promise)
      promise.finally(() => {
        if (syncSessionInflightByKey.get(key) === promise) {
          syncSessionInflightByKey.delete(key)
        }
      })
      return promise
    },
    [store, sdk, keyFor, touch, getMetaFor, setMetaFor, loadMessages, directory],
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

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; message: Message; parts: Part[] }) => {
      setOptimistic(input.sessionID, { message: input.message, parts: input.parts })
      const current = store.getState()
      const message = { ...current.message }
      const part = { ...current.part }

      // Insert message
      const messages = message[input.sessionID] ? [...message[input.sessionID]] : []
      const result = Binary.search(messages, input.message.id, (m) => m.id)
      if (!result.found) messages.splice(result.index, 0, input.message)
      message[input.sessionID] = messages

      // Insert parts
      part[input.message.id] = sortParts(input.parts)

      store.setState({ message, part })
    },
    [store, setOptimistic],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; messageID: string }) => {
      clearOptimistic(input.sessionID, input.messageID)
      const current = store.getState()
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

      store.setState({ message, part })
    },
    [store, clearOptimistic],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      loadMore,
      hasMore,
      isLoading,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
      },
    }),
    [syncSession, loadMore, hasMore, isLoading, optimisticAdd, optimisticRemove],
  )
}
