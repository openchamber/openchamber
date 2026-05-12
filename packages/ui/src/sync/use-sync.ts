import { useCallback, useRef, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  mergeOptimisticPage,
  type OptimisticItem,
} from "./optimistic"
import { useDirectoryStore, useSyncSDK, useSyncDirectory, useChildStoreManager } from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { stripMessageDiffSnapshots } from "./sanitize"
import {
  shouldSkipSessionPrefetch,
  getSessionPrefetch,
  setSessionPrefetch,
  clearSessionPrefetch,
} from "./session-prefetch-cache"
import { getSessionMaterializationStatus, materializeSessionSnapshots } from "./materialization"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const MESSAGE_PAGE_SIZE = 200
const MAX_SEEN_DIRS = 30
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sortParts(parts: Part[]) {
  return parts.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id))
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
  const inflight = useRef(new Map<string, Promise<void>>())
  const optimistic = useRef(new Map<string, Map<string, OptimisticItem>>())
  const seen = useRef(new Map<string, Set<string>>())
  const meta = useRef(new Map<string, {
    limit: number
    cursor: string | undefined
    complete: boolean
    loading: boolean
  }>())

  const keyFor = useCallback(
    (sessionID: string) => `${directory}\n${sessionID}`,
    [directory],
  )

  const getMetaFor = useCallback(
    (sessionID: string) => {
      const key = keyFor(sessionID)
      return meta.current.get(key) ?? { limit: MESSAGE_PAGE_SIZE, cursor: undefined, complete: false, loading: false }
    },
    [keyFor],
  )

  const setMetaFor = useCallback(
    (sessionID: string, patch: Partial<{ limit: number; cursor: string | undefined; complete: boolean; loading: boolean }>) => {
      const key = keyFor(sessionID)
      const current = meta.current.get(key) ?? { limit: MESSAGE_PAGE_SIZE, cursor: undefined, complete: false, loading: false }
      meta.current.set(key, { ...current, ...patch })
    },
    [keyFor],
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
    const existing = seen.current.get(directory)
    if (existing) {
      // LRU reorder: delete + re-insert moves to end (most recent)
      seen.current.delete(directory)
      seen.current.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.current.set(directory, created)

    // Evict oldest directories if over limit
    while (seen.current.size > MAX_SEEN_DIRS) {
      const first = seen.current.keys().next().value
      if (!first) break
      const staleSessionIds = [...(seen.current.get(first) ?? [])]
      seen.current.delete(first)
      evict(first, staleSessionIds)
    }

    return created
  }, [directory, evict])

  // Touch a session — triggers both directory-level and session-level eviction
  const touch = useCallback(
    (sessionID: string) => {
      const s = seenFor()
      const protectedIds = getProtectedSessionCacheIds(store.getState())
      const stale = pickSessionCacheEvictions({
        seen: s,
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
        preserve: protectedIds,
      })
      evict(directory, stale)
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
        const limit = m.limit
        const page = await fetchMessages(sessionID, limit, options?.before)

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

        store.setState({ message: materialized.message, part: materialized.part })
        setMetaFor(sessionID, {
          limit: materialized.messages.length,
          cursor: merged.cursor,
          complete: merged.complete,
          loading: false,
        })
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
      const existing = inflight.current.get(key)
      if (existing) return existing

      const current = store.getState()
      const m = getMetaFor(sessionID)
      const materialization = getSessionMaterializationStatus(current, sessionID)
      const cached = materialization.hasMessages && materialization.renderable && m.limit > 0
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cached && hasSession && !force) return

      // Skip if recently fetched (TTL)
      if (!force) {
        const prefetchInfo = getSessionPrefetch(directory, sessionID)
        if (shouldSkipSessionPrefetch({
          hasMessages: cached,
          info: prefetchInfo,
          pageSize: MESSAGE_PAGE_SIZE,
        })) return
      }

      const promise = (async () => {
        // Fetch session info if needed
        if (!hasSession || force) {
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
        }

        // Load messages if needed
        if (!cached || force) {
          await loadMessages(sessionID)
        }
      })()

      inflight.current.set(key, promise)
      promise.finally(() => inflight.current.delete(key))
      return promise
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
