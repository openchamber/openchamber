import { useCallback, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT, type State } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import {
  dropCachedSessionMessageRecordsSnapshots,
  useChildStoreManager,
  useDirectoryStore,
  useSessionMessageLoader,
  useSyncDirectory,
  useSyncSDK,
} from "./sync-context"
import { dropSessionCaches, getProtectedSessionCacheIds } from "./session-cache"
import { stripSessionDiffSnapshots } from "./sanitize"
import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"
import { clearSessionPrefetch } from "./session-prefetch-cache"
import { getSessionMaterializationStatus } from "./materialization"
import { getRuntimeKey } from "@/lib/runtime-switch"

const INITIAL_MESSAGE_PAGE_SIZE = 50
const VSCODE_INITIAL_MESSAGE_PAGE_SIZE = 30
const MOBILE_INITIAL_MESSAGE_PAGE_SIZE = 30
const MAX_SEEN_DIRS = 30
const VSCODE_SESSION_CACHE_LIMIT = 4
const MOBILE_SESSION_CACHE_LIMIT = 4

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
  const messageLoader = useSessionMessageLoader()

  const keyFor = useCallback(
    (sessionID: string, directoryOverride = directory) => `${getRuntimeKey()}\n${directoryOverride}\n${sessionID}`,
    [directory],
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
        messageLoader.invalidateSession({ directory: dir, sessionID: id })
      }
      clearSessionPrefetch(dir, sessionIDs)
    },
    [childStores, messageLoader],
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

  // Sync a session (load if not cached)
  const syncSession = useCallback(
    async (sessionID: string, force?: boolean, directoryOverride?: string) => {
      const targetDirectory = directoryOverride || directory
      if (targetDirectory === directory) touch(sessionID)
      const key = keyFor(sessionID, targetDirectory)

      // Dedup inflight requests
      const existing = syncSessionInflightByKey.get(key)
      if (existing) return existing

      // This is a new request. Bump generation so any older request that
      // might still be finishing (e.g. from a previous component lifecycle)
      // knows it is stale and should not write to the store.
      const generation = (syncSessionGenerationByKey.get(key) ?? 0) + 1
      syncSessionGenerationByKey.set(key, generation)
      const isStale = () => syncSessionGenerationByKey.get(key) !== generation

      const targetStore = targetDirectory === directory
        ? store
        : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const current = targetStore.getState()
      const materialization = getSessionMaterializationStatus(current, sessionID)
      const cachedReady = materialization.hasMessages && materialization.renderable
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cachedReady && hasSession && !force) return
      const shouldLoadMessages = Boolean(!cachedReady || force)
      const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
      const promise = (async () => {
        await Promise.all([
          shouldFetchSession
            ? (async () => {
                try {
                  const result = await retry(async () => {
                    const response = await sdk.session.get({ sessionID, directory: targetDirectory })
                    assertSdkSuccess(response, "session.get")
                    return response
                  })
                  if (result.data && !isStale()) {
                    const nextSession = stripSessionDiffSnapshots(result.data)
                    const s = targetStore.getState()
                    const sessions = [...s.session]
                    const idx = Binary.search(sessions, sessionID, (s) => s.id)
                    if (idx.found) {
                      sessions[idx.index] = nextSession
                    } else {
                      sessions.splice(idx.index, 0, nextSession)
                    }
                    if (!isStale()) {
                      targetStore.setState({ session: sessions })
                    }
                  }
                } catch (e) {
                  console.error("[sync] failed to fetch session", sessionID, e)
                }
              })()
            : Promise.resolve(),
          shouldLoadMessages
            ? messageLoader.ensure(
                { directory: targetDirectory, sessionID },
                { force, reason: "reactive" },
              )
            : Promise.resolve(),
        ])
      })()

      syncSessionInflightByKey.set(key, promise)
      const clearInflightRequest = () => {
        if (syncSessionInflightByKey.get(key) === promise) {
          syncSessionInflightByKey.delete(key)
          if (syncSessionGenerationByKey.get(key) === generation) {
            syncSessionGenerationByKey.delete(key)
          }
        }
      }
      void promise.then(clearInflightRequest, clearInflightRequest)
      return promise
    },
    [childStores, directory, keyFor, messageLoader, sdk, store, touch],
  )

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string, directoryOverride?: string) => {
      const targetDirectory = directoryOverride || directory
      if (targetDirectory === directory) touch(sessionID)
      await messageLoader.loadOlder({ directory: targetDirectory, sessionID })
    },
    [directory, messageLoader, touch],
  )

  const prefetchSession = useCallback(
    (sessionID: string, targetDirectory: string) => messageLoader.prefetch({ directory: targetDirectory, sessionID }),
    [messageLoader],
  )

  const hasMore = useCallback(
    (sessionID: string, directoryOverride?: string) => {
      const state = messageLoader.getSnapshot({ directory: directoryOverride || directory, sessionID })
      return !state.complete && Boolean(state.cursor)
    },
    [directory, messageLoader],
  )

  const isLoading = useCallback(
    (sessionID: string, directoryOverride?: string) => messageLoader
      .getSnapshot({ directory: directoryOverride || directory, sessionID }).status === "loading",
    [directory, messageLoader],
  )

  // True only when a fetch has positively confirmed the history is fully
  // loaded (no next cursor). Distinct from !hasMore(), which is also true for
  // sessions whose meta simply hasn't been populated yet.
  const isComplete = useCallback(
    (sessionID: string, directoryOverride?: string) => messageLoader
      .getSnapshot({ directory: directoryOverride || directory, sessionID }).complete,
    [directory, messageLoader],
  )

  // Optimistic add (for prompt submission)
  const optimisticAdd = useCallback(
    (input: { sessionID: string; directory?: string | null; message: Message; parts: Part[] }) => {
      messageLoader.optimisticAdd({
        directory: input.directory || directory,
        sessionID: input.sessionID,
        message: input.message,
        parts: input.parts,
      })
    },
    [directory, messageLoader],
  )

  // Optimistic remove (for rollback on error)
  const optimisticRemove = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      messageLoader.optimisticRemove({
        directory: input.directory || directory,
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
    },
    [directory, messageLoader],
  )

  const optimisticConfirm = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      messageLoader.optimisticConfirm({
        directory: input.directory || directory,
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
    },
    [directory, messageLoader],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      prefetchSession,
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
    [syncSession, prefetchSession, loadMore, hasMore, isLoading, isComplete, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}
