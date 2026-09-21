import { useCallback, useMemo } from "react"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import { upsertSessionRecord } from "./session-records"
import { retry } from "./retry"
import {
  useChildStoreManager,
  useDirectoryStore,
  useSessionMessageLoader,
  useSyncDirectory,
  useSyncSDK,
  useSyncRuntime,
  resyncBlockingRequestsForDirectory,
  buildSessionMessageRecordsSnapshot,
  recoverInterruptedTurnAfterMessageLoad,
} from "./sync-context"
import { stripSessionDiffSnapshots } from "./sanitize"
import { getSessionMaterializationStatus } from "./materialization"
import { getRuntimeKey } from "@/lib/runtime-switch"

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
  const { messageLoader, runtimeKey } = useSyncRuntime()
  return useCallback((sessionID: string, directory: string) => {
    if (getRuntimeKey() !== runtimeKey) return
    messageLoader.touchSessionCache({ directory, sessionID })
  }, [messageLoader, runtimeKey])
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

      const targetStore = targetDirectory === directory
        ? store
        : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const isStale = () => getRuntimeKey() !== runtimeKey
        || syncSessionGenerationByKey.get(key) !== generation
        || childStores.children.get(targetDirectory) !== targetStore
      const current = targetStore.getState()
      const materialization = getSessionMaterializationStatus(current, sessionID)
      const cachedReady = materialization.hasMessages && materialization.renderable
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cachedReady && hasSession && !force) {
        await recoverInterruptedTurnAfterMessageLoad(targetDirectory, targetStore, sessionID, isStale)
        return
      }
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
            ? (async () => {
                await messageLoader.ensure(
                  { directory: targetDirectory, sessionID },
                  { force, reason: "reactive" },
                )
                if (!isStale()) {
                  await recoverInterruptedTurnAfterMessageLoad(targetDirectory, targetStore, sessionID, isStale)
                }
              })()
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

  const prefetchSession = useCallback(
    async (sessionID: string, targetDirectory: string) => {
      if (getRuntimeKey() !== runtimeKey) return
      await messageLoader.prefetch({ directory: targetDirectory, sessionID })
    },
    [messageLoader, runtimeKey],
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
      recoverPendingQuestions,
      optimistic: {
        add: optimisticAdd,
        remove: optimisticRemove,
        confirm: optimisticConfirm,
      },
    }),
    [syncSession, prefetchSession, loadMore, hasMore, isLoading, isComplete, recoverPendingQuestions, optimisticAdd, optimisticRemove, optimisticConfirm],
  )
}

export function usePrefetchSessionMessages() {
  const { messageLoader, runtimeKey } = useSyncRuntime()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return
    await messageLoader.prefetch({ directory, sessionID })
  }, [messageLoader, runtimeKey])
}

export function useSessionMessageRecordsForExport() {
  const { childStores, messageLoader, runtimeKey } = useSyncRuntime()
  const touch = useSessionCacheTouch()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return null
    const store = childStores.ensureChild(directory, { bootstrap: false })
    touch(sessionID, directory)
    const target = { directory, sessionID }
    const release = messageLoader.retainSessionHistory(target)
    try {
      await messageLoader.loadComplete(target)
      if (getRuntimeKey() !== runtimeKey) return null
      return buildSessionMessageRecordsSnapshot(store.getState(), sessionID).list
    } finally {
      release()
    }
  }, [childStores, messageLoader, runtimeKey, touch])
}
