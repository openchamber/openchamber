import { useCallback, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { upsertSessionRecord } from "./session-records"
import { retry } from "./retry"
import { SESSION_CACHE_LIMIT, type State } from "./types"
import { dropSessionCaches, getProtectedSessionCacheIds, pickSessionCacheEvictions } from "./session-cache"
import {
  dropCachedSessionMessageRecordsSnapshots,
  useChildStoreManager,
  useDirectoryStore,
  useSessionMessageLoader,
  useSyncDirectory,
  useSyncSDK,
  useSyncRuntime,
  resyncBlockingRequestsForDirectory,
  buildSessionMessageRecordsSnapshot,
} from "./sync-context"
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
type SeenDirectoryEntry = {
  runtimeKey: string
  directory: string
  sessions: Set<string>
}
const seenByDirectory = new Map<string, SeenDirectoryEntry>()

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

function useSessionCacheTouch() {
  const { childStores, messageLoader, runtimeKey } = useSyncRuntime()

  const evict = useCallback(
    (directory: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0 || getRuntimeKey() !== runtimeKey) return
      const store = childStores.getChild(directory)
      if (!store) return

      const current = store.getState()
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
      dropCachedSessionMessageRecordsSnapshots(store, sessionIDs)
      store.setState(draft)
      for (const sessionID of sessionIDs) messageLoader.invalidateSession({ directory, sessionID })
      clearSessionPrefetch(directory, sessionIDs)
    },
    [childStores, messageLoader, runtimeKey],
  )

  const seenFor = useCallback((directory: string) => {
    const cacheKey = `${runtimeKey}\n${directory}`
    const existing = seenByDirectory.get(cacheKey)
    if (existing) {
      seenByDirectory.delete(cacheKey)
      seenByDirectory.set(cacheKey, existing)
      return existing.sessions
    }
    const created: SeenDirectoryEntry = { runtimeKey, directory, sessions: new Set() }
    seenByDirectory.set(cacheKey, created)
    while (seenByDirectory.size > MAX_SEEN_DIRS) {
      const oldestKey = seenByDirectory.keys().next().value
      if (!oldestKey) break
      const oldest = seenByDirectory.get(oldestKey)
      seenByDirectory.delete(oldestKey)
      if (oldest?.runtimeKey === runtimeKey) evict(oldest.directory, [...oldest.sessions])
    }
    return created.sessions
  }, [evict, runtimeKey])

  return useCallback((sessionID: string, directory: string) => {
    if (getRuntimeKey() !== runtimeKey) return
    const seen = seenFor(directory)
    const store = childStores.ensureChild(directory, { bootstrap: false })
    const protectedIds = getProtectedSessionCacheIds(store.getState())
    const stale = pickSessionCacheEvictions({
      seen,
      keep: sessionID,
      limit: getEffectiveSessionCacheLimit(),
      preserve: protectedIds,
    })
    evict(directory, stale)

    if (!isConstrainedSessionRuntime()) return
    const state = store.getState()
    const keep = new Set([sessionID, ...seen, ...protectedIds])
    const prefetched = Object.keys(state.message).filter((id) => !keep.has(id))
    evict(directory, prefetched)
    const afterPrefetchEviction = prefetched.length > 0 ? store.getState() : state
    const heavyInactive = Object.keys(afterPrefetchEviction.message).filter((id) => (
      id !== sessionID && !protectedIds.has(id) && isHeavyConstrainedSessionCache(afterPrefetchEviction, id)
    ))
    for (const id of heavyInactive) seen.delete(id)
    evict(directory, heavyInactive)
  }, [childStores, evict, runtimeKey, seenFor])
}

export function useSync() {
  const sdk = useSyncSDK()
  const directory = useSyncDirectory()
  const store = useDirectoryStore()
  const childStores = useChildStoreManager()
  const messageLoader = useSessionMessageLoader()
  const runtimeKey = getRuntimeKey()
  const touch = useSessionCacheTouch()

  const recoverPendingQuestions = useCallback(
    async (sessionID: string, directoryOverride?: string): Promise<boolean> => {
      const targetDirectory = directoryOverride || directory
      if (!sessionID || !targetDirectory || getRuntimeKey() !== runtimeKey) return false
      const targetStore = childStores.ensureChild(targetDirectory, {
        priority: "selected",
        reason: "selected-session",
      })
      await resyncBlockingRequestsForDirectory(targetDirectory, targetStore, [sessionID], {
        includePermissions: false,
      })
      if (getRuntimeKey() !== runtimeKey) return false
      return (targetStore.getState().question[sessionID]?.length ?? 0) > 0
    },
    [childStores, directory, runtimeKey],
  )

  const keyFor = useCallback(
    (sessionID: string, directoryOverride = directory) => `${runtimeKey}\n${directoryOverride}\n${sessionID}`,
    [directory, runtimeKey],
  )

  // Sync a session (load if not cached)
  const syncSession = useCallback(
    async (sessionID: string, force?: boolean, directoryOverride?: string) => {
      if (getRuntimeKey() !== runtimeKey) return
      const targetDirectory = directoryOverride || directory
      touch(sessionID, targetDirectory)
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
                    const sessions = upsertSessionRecord(s.session, nextSession)
                    if (sessions !== s.session && !isStale()) {
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
    [childStores, directory, keyFor, messageLoader, runtimeKey, sdk, store, touch],
  )

  // Load more (pagination)
  const loadMore = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      touch(sessionID, targetDirectory)
      await messageLoader.loadOlder({ directory: targetDirectory, sessionID })
    },
    [messageLoader, touch],
  )

  const loadCompleteHistory = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      touch(sessionID, targetDirectory)
      await messageLoader.loadComplete({ directory: targetDirectory, sessionID })
    },
    [messageLoader, touch],
  )

  const prefetchSession = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      if (getRuntimeKey() !== runtimeKey) return
      await messageLoader.prefetch({ directory: targetDirectory, sessionID })
      if (messageLoader.getSnapshot({ directory: targetDirectory, sessionID }).status === "ready") {
        touch(sessionID, targetDirectory)
      }
    },
    [messageLoader, runtimeKey, touch],
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
      loadCompleteHistory,
      hasMore,
      isLoading,
      isComplete,
      recoverPendingQuestions,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
        confirm: optimisticConfirm,
      },
    }),
    [syncSession, prefetchSession, loadMore, loadCompleteHistory, hasMore, isLoading, isComplete, recoverPendingQuestions, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}

export function usePrefetchSessionMessages() {
  const { messageLoader, runtimeKey } = useSyncRuntime()
  const touch = useSessionCacheTouch()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return
    await messageLoader.prefetch({ directory, sessionID })
    if (messageLoader.getSnapshot({ directory, sessionID }).status !== "ready") return
    touch(sessionID, directory)
  }, [messageLoader, runtimeKey, touch])
}

export function useSessionMessageRecordsForExport() {
  const { childStores, messageLoader, runtimeKey } = useSyncRuntime()
  const touch = useSessionCacheTouch()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return null
    const store = childStores.ensureChild(directory, { bootstrap: false })
    touch(sessionID, directory)
    await messageLoader.loadComplete({ directory, sessionID })
    if (getRuntimeKey() !== runtimeKey) return null
    return buildSessionMessageRecordsSnapshot(store.getState(), sessionID).list
  }, [childStores, messageLoader, runtimeKey, touch])
}
