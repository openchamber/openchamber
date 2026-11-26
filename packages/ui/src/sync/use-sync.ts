import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type { Message, Part, Session } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { Binary } from "./binary"
import { upsertSessionRecord } from "./session-records"
import { adoptSessionMove } from "./session-actions"
import { resolveSessionReadDirectory, type SessionReadDirectorySources } from "./session-read-directory"
import { withAdmittedLineage } from "./session-admission"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { retry } from "./retry"
import {
  useChildStoreManager,
  useDirectoryStore,
  useSessionMessageLoader,
  useSyncDirectory,
  useSyncRuntime,
  resyncBlockingRequestsForDirectory,
  buildSessionMessageRecordsSnapshot,
  markRecordedInterruptedTurn,
} from "./sync-context"
import { stripSessionDiffSnapshots } from "./sanitize"
import type { ChildStoreManager } from "./child-store"
import { getSessionMaterializationStatus } from "./materialization"
import { captureRuntimeInstance, getRuntimeKey } from "@/lib/runtime-switch"

const sessionReadDirectorySources: SessionReadDirectorySources = {
  knownDirectory: (sessionID) => {
    const record = useGlobalSessionsStore.getState().entityById.get(sessionID)
    return record ? withAdmittedLineage(sessionID, resolveGlobalSessionDirectory(record)) : null
  },
  readUnscoped: (sessionID) => opencodeClient.getSessionUnscoped(sessionID),
  adopt: adoptSessionMove,
}

const syncSessionInflightByKey = new Map<string, Promise<void>>()

const sessionRecordRefreshInflightByKey = new Map<string, Promise<void>>()

const syncSessionGenerationByKey = new Map<string, number>()

const isUserMessage = (message: Message): boolean => message.role === "user"

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
  const directory = useSyncDirectory()
  const store = useDirectoryStore()
  const childStores = useChildStoreManager()
  const messageLoader = useSessionMessageLoader()
  const runtimeKey = getRuntimeKey()
  const touch = useSessionCacheTouch()

  const recoverPendingQuestions = useCallback(
    async (sessionID: string, directoryOverride?: string): Promise<boolean> => {
      const selectedDirectory = directoryOverride || directory
      if (!sessionID || !selectedDirectory || getRuntimeKey() !== runtimeKey) return false
      const targetDirectory = await resolveSessionReadDirectory(sessionID, selectedDirectory, captureRuntimeInstance(), sessionReadDirectorySources)
      if (!targetDirectory) return false
      const targetStore = childStores.ensureChild(targetDirectory, {
        priority: "selected",
        reason: "selected-session",
      })
      await resyncBlockingRequestsForDirectory(targetDirectory, targetStore, [sessionID], {
        includePermissions: false,
      })
      if (getRuntimeKey() !== runtimeKey) return false
      return (targetStore.getState().form[sessionID]?.length ?? 0) > 0
    },
    [childStores, directory, runtimeKey],
  )

  const keyFor = useCallback(
    (sessionID: string, directoryOverride = directory) => `${runtimeKey}\n${directoryOverride}\n${sessionID}`,
    [directory, runtimeKey],
  )

  const syncSession = useCallback(
    async (sessionID: string, force?: boolean, directoryOverride?: string) => {
      if (getRuntimeKey() !== runtimeKey) return
      const selectedDirectory = directoryOverride || directory
      if (!selectedDirectory) return
      const targetDirectory = await resolveSessionReadDirectory(sessionID, selectedDirectory, captureRuntimeInstance(), sessionReadDirectorySources)
      if (!targetDirectory) return
      touch(sessionID, targetDirectory)
      const key = keyFor(sessionID, targetDirectory)

      const existing = syncSessionInflightByKey.get(key)
      if (existing) return existing

      const generation = (syncSessionGenerationByKey.get(key) ?? 0) + 1
      syncSessionGenerationByKey.set(key, generation)

      const targetStore = targetDirectory === directory
        ? store
        : childStores.ensureChild(targetDirectory, { bootstrap: false })
      const isStale = () => getRuntimeKey() !== runtimeKey
        || syncSessionGenerationByKey.get(key) !== generation
        || childStores.children.get(targetDirectory) !== targetStore
      const current = targetStore.getState()
      const materialization = getSessionMaterializationStatus(current, sessionID, {
        historyCovered: messageLoader.coversHistory({ directory: targetDirectory, sessionID }),
      })
      const cachedReady = materialization.hasMessages && materialization.renderable
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      if (cachedReady && hasSession && !force) {
        if (!isStale()) markRecordedInterruptedTurn(targetStore, sessionID)
        messageLoader.revalidateIfStale({ directory: targetDirectory, sessionID })
        return
      }
      const shouldLoadMessages = Boolean(!cachedReady || force)
      const shouldFetchSession = shouldFetchSessionForRenderableSync({ hasSession, shouldLoadMessages, force: Boolean(force) })
      const promise = (async () => {
        await Promise.all([
          shouldFetchSession
            ? (async () => {
                try {
                  const session = await retry(() => opencodeClient.getSession(sessionID, targetDirectory))
                  if (!isStale()) {
                    const nextSession = stripSessionDiffSnapshots(session)
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
                  markRecordedInterruptedTurn(targetStore, sessionID)
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
    [childStores, directory, keyFor, messageLoader, runtimeKey, store, touch],
  )

  const refreshRecord = useCallback(
    async (sessionID: string, directoryOverride?: string): Promise<void> => {
      const selectedDirectory = directoryOverride || directory
      if (!selectedDirectory) return
      return refreshSessionRecord({ childStores, sessionID, directory: selectedDirectory, runtimeKey })
    },
    [childStores, directory, runtimeKey],
  )

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

  const isComplete = useCallback(
    (sessionID: string, directoryOverride?: string) => messageLoader
      .getSnapshot({ directory: directoryOverride || directory, sessionID }).complete,
    [directory, messageLoader],
  )

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

  const optimisticAdmit = useCallback(
    (input: { sessionID: string; directory?: string | null; messageID: string }) => {
      messageLoader.optimisticAdmit({ directory: input.directory || directory, sessionID: input.sessionID, messageID: input.messageID })
    },
    [directory, messageLoader],
  )

  return useMemo(
    () => ({
      ensureSessionRenderable: syncSession,
      syncSession,
      refreshSessionRecord: refreshRecord,
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
        admit: optimisticAdmit,
      },
    }),
    [syncSession, refreshRecord, prefetchSession, loadMore, hasMore, isLoading, isComplete, recoverPendingQuestions, optimisticAdd, optimisticRemove, optimisticConfirm, optimisticAdmit],
  )
}

function reconcileFetchedRecord(baseline: Session, shown: Session, fetched: Session): Session {
  const before = new Map(Object.entries(baseline))
  const live = new Map(Object.entries(shown))
  const changedMeanwhile = [...new Set([...before.keys(), ...live.keys()])]
    .filter((field) => JSON.stringify(live.get(field)) !== JSON.stringify(before.get(field)))
    .map((field) => [field, live.get(field)] as const)
  return { ...fetched, ...Object.fromEntries(changedMeanwhile) }
}

export async function refreshSessionRecord({ childStores, sessionID, directory, runtimeKey }: {
  childStores: ChildStoreManager
  sessionID: string
  directory: string
  runtimeKey: string
}): Promise<void> {
  const isCurrent = () => getRuntimeKey() === runtimeKey
  if (!isCurrent()) return
  const targetDirectory = await resolveSessionReadDirectory(sessionID, directory, captureRuntimeInstance(), sessionReadDirectorySources)
  if (!targetDirectory || !isCurrent()) return
  const key = `${runtimeKey}\n${targetDirectory}\n${sessionID}`
  if (syncSessionInflightByKey.has(key)) return
  const existing = sessionRecordRefreshInflightByKey.get(key)
  if (existing) return existing
  const targetStore = childStores.children.get(targetDirectory)
  if (!targetStore) return

  const findShown = (sessions: Session[]) => {
    const result = Binary.search(sessions, sessionID, (s) => s.id)
    return result.found ? sessions[result.index] : undefined
  }
  const baseline = findShown(targetStore.getState().session)
  if (!baseline) return
  const promise = (async () => {
    const session = await retry(() => opencodeClient.getSession(sessionID, targetDirectory)).catch(() => null)
    if (!session || !isCurrent() || childStores.children.get(targetDirectory) !== targetStore) return
    const fetched = stripSessionDiffSnapshots(session)
    if (fetched.time?.archived) return
    const current = targetStore.getState()
    const shown = findShown(current.session)
    if (!shown) return
    const sessions = upsertSessionRecord(current.session, reconcileFetchedRecord(baseline, shown, fetched))
    if (sessions !== current.session) targetStore.setState({ session: sessions })
  })()

  sessionRecordRefreshInflightByKey.set(key, promise)
  const clearInflightRequest = () => {
    if (sessionRecordRefreshInflightByKey.get(key) === promise) {
      sessionRecordRefreshInflightByKey.delete(key)
    }
  }
  void promise.then(clearInflightRequest, clearInflightRequest)
  return promise
}

const sessionRecordDemand = new Map<string, number>()
const sessionRecordDemandListeners = new Set<() => void>()

const notifySessionRecordDemand = () => {
  for (const listener of sessionRecordDemandListeners) listener()
}

const subscribeSessionRecordDemand = (listener: () => void) => {
  sessionRecordDemandListeners.add(listener)
  return () => {
    sessionRecordDemandListeners.delete(listener)
  }
}

export function useSessionRecordDemand(sessionID: string | null, shown: boolean): void {
  useEffect(() => {
    if (!shown || !sessionID) return undefined
    sessionRecordDemand.set(sessionID, (sessionRecordDemand.get(sessionID) ?? 0) + 1)
    notifySessionRecordDemand()
    return () => {
      const count = (sessionRecordDemand.get(sessionID) ?? 1) - 1
      if (count > 0) sessionRecordDemand.set(sessionID, count)
      else sessionRecordDemand.delete(sessionID)
      notifySessionRecordDemand()
    }
  }, [sessionID, shown])
}

export function useSessionRecordRefresh(
  { sessionID, directory, ownsContextSources, hasRenderableSnapshot }: {
    sessionID: string | null
    directory: string | null
    ownsContextSources: boolean
    hasRenderableSnapshot: boolean
  },
  refresh: (sessionID: string, directory?: string) => Promise<void>,
): void {
  const demanded = useSyncExternalStore(
    subscribeSessionRecordDemand,
    () => (sessionID ? sessionRecordDemand.has(sessionID) : false),
  )
  const visitKeyRef = useRef<string | null>(null)
  const visitKey = ownsContextSources && demanded && sessionID && directory
    ? `${getRuntimeKey()}\n${directory}\n${sessionID}`
    : null
  useEffect(() => {
    if (!visitKey || !sessionID || !directory) {
      visitKeyRef.current = null
      return
    }
    if (visitKeyRef.current === visitKey) return
    visitKeyRef.current = visitKey
    if (!hasRenderableSnapshot) return
    void refresh(sessionID, directory)
  }, [visitKey, sessionID, directory, hasRenderableSnapshot, refresh])
}

export function usePrefetchSessionMessages() {
  const { messageLoader, runtimeKey } = useSyncRuntime()

  return useCallback(async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return
    await messageLoader.prefetch({ directory, sessionID })
  }, [messageLoader, runtimeKey])
}

export function useLoadedSessionMessageRecords() {
  const { childStores, runtimeKey } = useSyncRuntime()

  return useCallback(({ directory, sessionID }: { directory: string; sessionID: string }) => {
    if (getRuntimeKey() !== runtimeKey) return null
    const store = childStores.getChild(directory)
    return store ? buildSessionMessageRecordsSnapshot(store.getState(), sessionID).list : null
  }, [childStores, runtimeKey])
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
