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

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const INITIAL_MESSAGE_PAGE_SIZE = 50
const VSCODE_INITIAL_MESSAGE_PAGE_SIZE = 30
const MOBILE_INITIAL_MESSAGE_PAGE_SIZE = 30
const HISTORY_MESSAGE_PAGE_SIZE = 100
const INITIAL_PAGE_EXPANSION_LIMITS = [100, 150] as const
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

// Per-session generation counter. When a newer syncSession request starts for
// the same session, older in-flight requests become stale and must not write
// to the store. This prevents rapid session switches (e.g. 1→2→3 in the
// sidebar) from having each completed fetch fight for focus.
const syncSessionGenerationByKey = new Map<string, number>()

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
const getInitialPageExpansionLimits = () => isConstrainedSessionRuntime()
  ? VSCODE_INITIAL_PAGE_EXPANSION_LIMITS
  : INITIAL_PAGE_EXPANSION_LIMITS
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

export function hasUserMessage(messages: Message[] | undefined): boolean {
  return Boolean(messages?.some(isUserMessage))
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
      const result = await retry(async () => {
        const response = await sdk.session.messages({ sessionID, directory, limit, before })
        assertSdkSuccess(response, "session.messages")
        return response
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
      return { session, part, cursor, complete: !cursor }
    },
    [sdk, directory],
  )

  // Load messages for a session
  const loadMessages = useCallback(
    async (sessionID: string, options?: { before?: string; mode?: "replace" | "prepend"; isStale?: () => boolean }) => {
      const m = getMetaFor(sessionID)
      if (m.loading) return
      setMetaFor(sessionID, { loading: true })

      try {
        // Commit a fetched page to the store: merge optimistic items, run
        // materialization, and write the result so the UI can render it.
        // Returns the committed meta so the caller can update pagination
        // state once at the end. The store write happens here (per page) so
        // the hydrating skeleton disappears after the first fetch instead of
        // waiting for the full expansion sequence.
        const commitMessagesToStore = (
          page: Awaited<ReturnType<typeof fetchMessages>>,
          mode: "replace" | "prepend" | undefined,
          isStale?: () => boolean,
        ) => {
          const items = getOptimistic(sessionID)
          const merged = mergeOptimisticPage(page, items)
          for (const messageID of merged.confirmed) {
            clearOptimistic(sessionID, messageID)
          }

          if (isStale?.()) {
            return { messages: [], cursor: merged.cursor, complete: merged.complete }
          }

          const current = store.getState()
          const materialized = materializeSessionSnapshots(
            current,
            sessionID,
            merged.session.map((info) => ({
              info,
              parts: merged.part.find((item) => item.id === info.id)?.part ?? [],
            })),
            { skipPartTypes: SKIP_PARTS, mode: mode === "prepend" ? "prepend" : "merge" },
          )

          // materializeSessionSnapshots is synchronous today, so this check
          // is defense-in-depth: it guards the store write if materialization
          // ever becomes async or yields between the check above and setState.
          if (isStale?.()) {
            return { messages: [], cursor: merged.cursor, complete: merged.complete }
          }

          if (materialized.messagesChanged || materialized.partsChanged) {
            store.setState({
              ...(materialized.messagesChanged ? { message: materialized.message } : {}),
              ...(materialized.partsChanged ? { part: materialized.part } : {}),
            })
          }
          return { messages: materialized.messages, cursor: merged.cursor, complete: merged.complete }
        }

        const limit = options?.before ? HISTORY_MESSAGE_PAGE_SIZE : m.limit
        const page = await fetchMessages(sessionID, limit, options?.before)

        // Commit the first page to the store immediately so the hydrating
        // skeleton disappears after a single round-trip — but only when the
        // page already contains a user message boundary. If the tail is
        // assistant/tool-only (a very large final turn), committing now would
        // drop the skeleton and render an empty chat (turn projection skips
        // assistant messages without a user parent), which looks like a fresh
        // session instead of a loading state. In that case defer the first
        // commit to the expansion loop below, which fetches older records
        // until a user boundary appears and commits that page instead.
        //
        // The deferral only applies to the initial fetch (no `before`).
        // Prepend mode (loading older history) always commits — messages are
        // already rendered, so there is no skeleton to protect, and skipping
        // the store write would drop the fetched older messages entirely.
        //
        // The deferred fallback carries page.session (not []) so that if the
        // expansion loop is ever a no-op (e.g. all nextLimit <= limit after a
        // constant change), the final setMetaFor reflects the real fetched
        // count instead of overwriting it with 0.
        const deferFirstCommit =
          !options?.before && !page.complete && !hasUserMessage(page.session)
        let committed = deferFirstCommit
          ? { messages: page.session, cursor: page.cursor, complete: page.complete }
          : commitMessagesToStore(page, options?.mode, options?.isStale)

        // If the first commit detected a stale session, bail out immediately
        // instead of relying on downstream guards to skip the final setMetaFor.
        if (options?.isStale?.()) {
          setMetaFor(sessionID, { loading: false })
          return
        }

        // Keep the initial page small for switch performance. Some sessions
        // have a very large final turn, so the latest records can
        // contain only assistant/tool records and no user boundary. That makes
        // turn projection render an empty chat until the user manually loads
        // older messages. Expand only this initial tail fetch, with a hard cap.
        // Each expanded page is committed to the store incrementally so the
        // user sees content as soon as a user boundary appears, instead of
        // waiting for the full expansion sequence before the first paint.
        if (!options?.before && !page.complete && !hasUserMessage(page.session)) {
          for (const nextLimit of getInitialPageExpansionLimits()) {
            if (nextLimit <= limit) continue
            if (options?.isStale?.()) {
              setMetaFor(sessionID, { loading: false })
              return
            }
            const expandedPage = await fetchMessages(sessionID, nextLimit)
            if (options?.isStale?.()) {
              setMetaFor(sessionID, { loading: false })
              return
            }
            committed = commitMessagesToStore(expandedPage, options?.mode, options?.isStale)
            if (options?.isStale?.()) {
              setMetaFor(sessionID, { loading: false })
              return
            }
            if (expandedPage.complete || hasUserMessage(expandedPage.session)) break
          }
        }

        if (options?.isStale?.()) {
          setMetaFor(sessionID, { loading: false })
          return
        }

        setMetaFor(sessionID, {
          limit: committed.messages.length,
          cursor: committed.cursor,
          complete: committed.complete,
          loading: false,
        })
        setSessionPrefetch({
          directory,
          sessionID,
          limit: committed.messages.length,
          cursor: committed.cursor,
          complete: committed.complete,
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

      // This is a new request. Bump generation so any older request that
      // might still be finishing (e.g. from a previous component lifecycle)
      // knows it is stale and should not write to the store.
      const generation = (syncSessionGenerationByKey.get(key) ?? 0) + 1
      syncSessionGenerationByKey.set(key, generation)
      const isStale = () => syncSessionGenerationByKey.get(key) !== generation

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

      const shouldLoadMessages = Boolean(!cachedReady || force)
      const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
      const promise = (async () => {
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

        // Progressive mount (desktop/VS Code): after the initial page
        // resolves, if the session isn't stale and the server indicated more
        // messages, dispatch a second fetch to prepend older history — it
        // gives the scroll container headroom so the scroll-up trigger fires
        // seamlessly. Mobile deliberately opts out: it has no scroll-position
        // trigger at all — ALL older history loads happen through the
        // explicit "load older" button at the top, so every prepend lands
        // from a resting state the user initiated. (The initial page itself,
        // including the turn-boundary extension, is unaffected.)
        if (!isStale() && !isMobileSurfaceRuntime()) {
          const currentMeta = getMetaFor(sessionID)
          if (currentMeta.cursor && !currentMeta.complete) {
            loadMessages(sessionID, { before: currentMeta.cursor, mode: "prepend", isStale })
          }
        }
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

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      loadMore,
      hasMore,
      isLoading,
      isComplete,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
      },
    }),
    [syncSession, loadMore, hasMore, isLoading, isComplete, optimisticAdd, optimisticRemove],
  )
}
