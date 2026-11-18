/* oxlint-disable react/only-export-components */
import React, { useEffect, useRef, useCallback, useMemo } from "react"
import type { StoreApi } from "zustand"
import { type SyncEvent } from "@/lib/opencode/events"
import { createEventPipeline } from "./event-pipeline"
import { isVSCodeRuntime } from "@/lib/desktop"
import { type SessionMaterializationReason } from "./event-reducer"
import { useGlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryBootstrapContext, type DirectoryStore } from "./child-store"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { updateChangedStreamingSessions, updateStreamingState } from "./streaming"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { noteDeferredAnswersLoaded } from "./recoverable-questions"
import { setActionRefs } from "./session-actions"
import { subscribeSessionAdmission } from "./session-admission"
import { setSyncRefs } from "./sync-refs"
import { useSessionUIStore } from "./session-ui-store"
import { useUIStore } from "@/stores/useUIStore"
import { selectNewChildSessions } from "./child-session-discovery"
import { normalizePath } from "@/lib/pathNormalization"
import { mergeBootstrapSessions } from "./reconnect-recovery"
import { opencodeClient } from "@/lib/opencode/client"
import { usePermissionStore } from "@/stores/permissionStore"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { isAutoReviewAvailable, useAutoReviewStore } from "@/stores/useAutoReviewStore"
import { subscribeMessageQueueSync } from "./message-queue-sync"
import { subscribeAutoReviewSync } from "./auto-review-sync"
import { subscribePrWatchSync } from "./pr-watch-sync"
import { subscribeExtensionWaitsSync } from "./extension-waits-sync"
import { subscribeLaterPagesSync } from "./later-pages-sync"
import { subscribeSessionWarmingSync } from "./session-warming-sync"
import { subscribeSessionTodosSync } from "./session-todos-sync"
import { subscribeSessionFoldersSync } from "./session-folders-sync"
import { subscribeSessionDraftsSync } from "./session-drafts-sync"
import { subscribePermissionPolicySync, subscribeSpacePermissionModes } from "./permission-mode-sync"
import { subscribeControlStreamSync } from "./control-stream-sync"
import { subscribeSpaceCatalogs } from "./space-catalog-sync"
import { subscribeSpaceSessionProject } from "./space-session-project"
import { useConfigStore } from "@/stores/useConfigStore"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { spaceIdOfDirectory } from "@/lib/spaces/space-route"
import { isDirectoryOfKnownSpace, isSpaceDirectoryStopped, isSpaceStopped, knownSpaceIds, refreshSpacesJourney, spaceIdsGone, spacesRuntimeGeneration, useSpacesStore } from "@/lib/spaces/spaces-store"
import { toast } from "@/components/ui"
import { applyGlobalSessionStatusSnapshot, getDirectoryOwnedSessionIds, setSessionParentResolver, useGlobalSessionStatusStore } from "./global-session-status"
import { settledPageKeys, useGlobalBlockingRequestsStore } from "./global-blocking-requests"
import { requestHostTurnStarts } from "./host-session-status-seed"
import { setHostTurnStartRequester } from "./session-activity-timing"
import { refreshBackgroundImages } from "./background-images"
import { CHAT_LOCATION_RELEASE_DELAY_MS, PROJECT_LOCATION_RELEASE_DELAY_MS, WORKTREE_LOCATION_RELEASE_DELAY_MS, createRealLocationRelease, directoryUse, isWorktreeDirectory, type LocationRelease } from "./location-release"
import { subscribeSessionAssistSettled } from "./pending-session-assists"
import { useWorkflowRunsStore } from "@/lib/workflows/store"
import { setWorkflowRunningSessions } from "./workflow-activity"
import { isChatDirectoryPath } from "@/lib/chatDirectories"
import { getRuntimeLiveStatusSeed, LIVE_STATUS_TTL_MS } from "./runtime-live-memory"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { isFilesystemError } from "@/lib/api/files-errors"
import { renewWatchedFiles } from "@/lib/watchedFiles"
import { listGlobalSessionPages, splitGlobalSessionsByArchived, type GlobalSessionRecord } from "@/stores/globalSessions"
import { SessionMessageLoader, getImperativeSessionMessageLoader, setImperativeSessionMessageLoader, type SessionMessageTarget } from "./session-message-loader"
import { openCodeStartupSignal } from "./opencode-startup-gate"
import { notifyStreamGap } from "./stream-gap"
import { type OpenCodeClient, type CurrentDirectorySource, type SyncRuntime, type SyncSystem, SyncContext, SyncRuntimeContext } from "./sync-runtime-context"
import { type EventRoutingIndex, createEventRoutingIndex, ingestDirectoryStateIntoRoutingIndex, resolveDirectoryFromRoutingIndex, setIndexedSessionDirectory } from "./event-routing-index"
import { type DirectoryReadBackoff, recordWatchdogReadFailure, CHILD_SESSION_DISCOVERY_RETRY_MS, ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS, ACTIVE_SESSION_STATUS_POLL_MAX_BACKOFF_MS, CHILD_SESSION_DISCOVERY_WAIT_MS, ACTIVE_SESSION_STALE_EVENT_MS, ACTIVE_SESSION_STATUS_POLL_HEALTHY_INTERVAL_MS, shouldTriggerStaleResync, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS, ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS } from "./sync-watchdog-policy"
import { listSessionPage } from "./session-page-listing"
import { enqueueSessionMaterialization } from "./session-materialization-recovery"
import { statusPollingDirectories, resyncDirectorySessionStatuses, needsSnapshotAfterStatusPoll, getActiveSessionCandidateIds, getLiveSessionCandidateIds } from "./session-status-recovery"
import { isDirectoryExternallyViewed, isSessionCacheViewed } from "./viewed-sessions"
import { resyncDirectoryAfterReconnect, reconcileActivityAfterGap } from "./session-reconnect-recovery"
import { resyncBlockingRequestsForActiveDirectory } from "./blocking-request-recovery"
import { dormantLocations, wakeDormantLocations } from "./dormant-locations"
import { isUiFocused } from "./surface-notifications"
import { handleEvent } from "./sync-event-dispatch"
import { applyControlStreamOnlyEvent } from "./sync-control-events"
import { createDirectoryEventBatch, publishDirectoryEventBatch } from "./directory-event-batch"
import { dropCachedSessionMessageRecordsSnapshots } from "./session-message-records"

useWorkflowRunsStore.subscribe((state) => {
  setWorkflowRunningSessions(Object.entries(state.bySession).flatMap(([sessionId, entry]) => (
    entry.runs.some((run) => run.state === "running") ? [sessionId] : []
  )))
})

useGlobalBlockingRequestsStore.subscribe((state, previous) => {
  if (state.bySession === previous.bySession) return
  const settled = settledPageKeys(previous.bySession, state.bySession)
  if (settled.length === 0) return
  const shown = new Set(toast.getToasts().map((entry) => entry.id))
  for (const key of settled) {
    if (shown.has(`page-${key}`)) toast.dismiss(`page-${key}`)
  }
})

setSessionParentResolver((sessionId) => useGlobalSessionsStore.getState().entityById.get(sessionId)?.parentID)

setHostTurnStartRequester(requestHostTurnStarts)

let bootingRoot = false
let bootedAt = 0
let globalBootstrapGeneration = 0
const BOOT_DEBOUNCE_MS = 1500

export function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
}

const childDiscoveryDirectories = new Set<string>()
const SHOULD_DISPATCH_VSCODE_NOTIFICATIONS = isVSCodeRuntime()

const dispatchVSCodeRuntimeNotificationEvent = (directory: string, payload: SyncEvent) => {
  if (!SHOULD_DISPATCH_VSCODE_NOTIFICATIONS || typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:vscode-notification-event", {
    detail: { directory, payload },
  }))
}

const dispatchOpenCodeUpdateAvailable = (payload: { version: string }) => {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent("openchamber:opencode-update-available", { detail: payload }))
}

const followCurrentChatToArchive = (goneIds: ReadonlySet<string>): boolean => {
  const ui = useSessionUIStore.getState()
  const current = normalizePath(ui.currentSessionDirectory)
  const spaceId = spaceIdOfDirectory(current)
  if (!ui.currentSessionId || spaceId === null || !goneIds.has(spaceId)) return true
  const archived = normalizePath(useGlobalSessionsStore.getState().entityById.get(ui.currentSessionId)?.directory)
  if (!archived || archived === current) return false
  ui.setSessionDirectory(ui.currentSessionId, archived)
  return true
}

type SyncStores = { childStores: ChildStoreManager; messageLoader: SessionMessageLoader }

const createSyncStores = (): SyncStores => {
  const childStores = new ChildStoreManager({ seedsSessions: isDirectoryOfKnownSpace })
  return {
    childStores,
    messageLoader: new SessionMessageLoader(childStores, { sdk: opencodeClient, runtimeKey: getRuntimeKey() }, openCodeStartupSignal),
  }
}

let syncStoresMadeBeforeMount: SyncStores | null = null

export function prefetchSessionBeforeMount(target: SessionMessageTarget): void {
  syncStoresMadeBeforeMount ??= createSyncStores()
  void syncStoresMadeBeforeMount.messageLoader.prefetch(target)
}

export function SyncProvider(props: {
  sdk: OpenCodeClient
  directory: string
  children: React.ReactNode
}) {
  const messageStreamTransport = useConfigStore((state) => state.settingsMessageStreamTransport)
  const syncStoresRef = useRef<SyncStores | null>(null)
  if (!syncStoresRef.current) syncStoresRef.current = syncStoresMadeBeforeMount ?? createSyncStores()
  const { childStores, messageLoader } = syncStoresRef.current
  useEffect(() => {
    if (syncStoresMadeBeforeMount === syncStoresRef.current) syncStoresMadeBeforeMount = null
  }, [])
  useEffect(() => {
    const noteLoadedAnswers = () => {
      for (const store of childStores.children.values()) noteDeferredAnswersLoaded(store.getState().message)
    }
    noteLoadedAnswers()
    return childStores.subscribeAllSelected((state) => state.message, noteLoadedAnswers)
  }, [childStores])
  const runtimeKey = getRuntimeKey()
  const messageLoaderDisposalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  messageLoader.configure({ sdk: opencodeClient, runtimeKey })
  useEffect(() => {
    opencodeClient.learnMessagePageShellsSupport()
  }, [runtimeKey])
  const routingIndexRef = useRef<EventRoutingIndex | null>(null)
  if (!routingIndexRef.current) routingIndexRef.current = createEventRoutingIndex()
  const routingIndex = routingIndexRef.current
  const currentDirectoryRef = useRef(props.directory)
  currentDirectoryRef.current = props.directory
  const currentDirectoryListenersRef = useRef(new Set<() => void>())
  const currentDirectorySource = useMemo<CurrentDirectorySource>(() => ({
    get: () => currentDirectoryRef.current,
    subscribe: (notify) => {
      currentDirectoryListenersRef.current.add(notify)
      return () => currentDirectoryListenersRef.current.delete(notify)
    },
  }), [])
  React.useLayoutEffect(() => {
    for (const notify of currentDirectoryListenersRef.current) notify()
  }, [props.directory])
  const locationReleaseRef = useRef<LocationRelease | null>(null)
  const previousDirectoryRef = useRef(props.directory)
  useEffect(() => {
    const expectedRuntimeKey = getRuntimeKey()
    const sdkEpoch = opencodeClient.getSdkClient()
    const release = createRealLocationRelease({
      releaseDelayMs: (directory) => {
        if (isChatDirectoryPath(directory)) return CHAT_LOCATION_RELEASE_DELAY_MS
        if (isWorktreeDirectory(directory, useSessionUIStore.getState().availableWorktreesByProject)) {
          return WORKTREE_LOCATION_RELEASE_DELAY_MS
        }
        return PROJECT_LOCATION_RELEASE_DELAY_MS
      },
      isCurrentDirectory: (directory) => directory === currentDirectoryRef.current,
      directoryUse: (directory) => isDirectoryExternallyViewed(directory)
        ? "busy"
        : directoryUse(directory, childStores.getChild(directory)?.getState()),
      release: async (directory) => {
        if (getRuntimeKey() !== expectedRuntimeKey || opencodeClient.getSdkClient() !== sdkEpoch) return
        await opencodeClient.releaseLocation(directory)
      },
    })
    locationReleaseRef.current = release
    const unsubscribeAssistSettled = subscribeSessionAssistSettled((isSettledDirectory) => release.recheck(isSettledDirectory))
    return () => {
      unsubscribeAssistSettled()
      release.dispose()
      if (locationReleaseRef.current === release) locationReleaseRef.current = null
    }
  }, [childStores, props.sdk])
  useEffect(() => {
    const previous = previousDirectoryRef.current
    previousDirectoryRef.current = props.directory
    locationReleaseRef.current?.directoryChanged(previous, props.directory)
  }, [props.directory])
  const lastStreamActivityAtRef = useRef(0)
  const lastStatusPollAtByDirectoryRef = useRef(new Map<string, number>())
  const statusPollBackoffByDirectoryRef = useRef(new Map<string, number>())
  const lastFullResyncAtByDirectoryRef = useRef(new Map<string, number>())
  const childDiscoveryDueAtByDirectoryRef = useRef(new Map<string, number>())
  const staleResyncBackoffByDirectoryRef = useRef<DirectoryReadBackoff>(new Map())
  const childDiscoveryBackoffByDirectoryRef = useRef<DirectoryReadBackoff>(new Map())
  const resyncingDirectoriesRef = useRef(new Set<string>())
  const blockingRequestResyncingDirectoriesRef = useRef(new Set<string>())
  const pipelineReconnectRef = useRef<((reason?: string) => void) | null>(null)
  const pipelineHasConnectedRef = useRef(false)
  const pipelineDisconnectedBeforeFirstConnectRef = useRef(false)

  const runtime = useMemo<SyncRuntime>(
    () => ({ childStores, messageLoader, runtimeKey, sdk: props.sdk, currentDirectory: currentDirectorySource }),
    [childStores, currentDirectorySource, messageLoader, props.sdk, runtimeKey],
  )
  const system = useMemo<SyncSystem>(
    () => ({ ...runtime, directory: props.directory }),
    [props.directory, runtime],
  )

  useEffect(() => {
    staleResyncBackoffByDirectoryRef.current = new Map()
    childDiscoveryBackoffByDirectoryRef.current = new Map()
  }, [childStores, props.sdk, runtimeKey])

  const replayResyncDirectoriesRef = useRef(new Map<string, SessionMaterializationReason | null>())
  const triggerDirectoryResyncRef = useRef<(directory: string, reason: SessionMaterializationReason) => void>(() => undefined)
  const triggerDirectoryResync = useCallback((directory: string, reason: SessionMaterializationReason) => {
    const store = childStores.children.get(directory)
    if (!store) return
    const staleResyncBackoff = staleResyncBackoffByDirectoryRef.current
    if (reason === "stale-status-resync" && Date.now() < (staleResyncBackoff.get(directory)?.retryAt ?? 0)) return
    const resyncing = resyncingDirectoriesRef.current
    const replayResyncs = replayResyncDirectoriesRef.current
    if (resyncing.has(directory)) {
      if (replayResyncs.has(directory) && reason !== "stream-replayed") replayResyncs.set(directory, reason)
      return
    }
    if (reason === "stream-replayed") replayResyncs.set(directory, null)

    if (reason !== "stream-replayed") lastFullResyncAtByDirectoryRef.current.set(directory, Date.now())
    resyncing.add(directory)
    const sdk = opencodeClient.getSdkClient()
    const expectedRuntimeKey = getRuntimeKey()
    const isStale = () => getRuntimeKey() !== expectedRuntimeKey
      || opencodeClient.getSdkClient() !== sdk || childStores.children.get(directory) !== store
      || staleResyncBackoffByDirectoryRef.current !== staleResyncBackoff
    void resyncDirectoryAfterReconnect(directory, store, routingIndex, reason, isStale)
      .then((succeeded) => {
        if (isStale()) return
        if (succeeded) staleResyncBackoff.delete(directory)
        else recordWatchdogReadFailure(staleResyncBackoff, directory, ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS)
      })
      .catch(() => {
        if (!isStale()) recordWatchdogReadFailure(staleResyncBackoff, directory, ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS)
      })
      .finally(() => {
        resyncing.delete(directory)
        const queued = replayResyncs.get(directory)
        replayResyncs.delete(directory)
        if (queued && !isStale()) triggerDirectoryResyncRef.current(directory, queued)
      })
  }, [childStores, routingIndex])
  useEffect(() => {
    triggerDirectoryResyncRef.current = triggerDirectoryResync
  }, [triggerDirectoryResync])

  useEffect(() => {
    if (typeof window === "undefined") return

    const onSystemResume = () => {
      const directory = currentDirectoryRef.current
      if (!directory || !childStores.getChild(directory)) return

      const resyncing = blockingRequestResyncingDirectoriesRef.current
      if (resyncing.has(directory)) return
      resyncing.add(directory)
      void resyncBlockingRequestsForActiveDirectory(directory, childStores)
        .finally(() => resyncing.delete(directory))
    }

    window.addEventListener("openchamber:system-resume", onSystemResume)
    return () => window.removeEventListener("openchamber:system-resume", onSystemResume)
  }, [childStores])

  useEffect(() => {
    const onReturn = () => {
      if (dormantLocations.size > 0 && isUiFocused()) wakeDormantLocations(childStores, currentDirectoryRef.current)
    }
    window.addEventListener("focus", onReturn)
    document.addEventListener("visibilitychange", onReturn)
    return () => {
      window.removeEventListener("focus", onReturn)
      document.removeEventListener("visibilitychange", onReturn)
      dormantLocations.clear()
    }
  }, [childStores])

  useEffect(() => {
    void usePermissionStore.getState().hydrate().catch(() => undefined)
    void useMessageQueueStore.getState().hydrate().catch(() => undefined)
    if (isAutoReviewAvailable()) void useAutoReviewStore.getState().hydrate().catch(() => undefined)
  }, [props.sdk])

  useEffect(() => {
    const expectedRuntimeKey = getRuntimeKey()
    const sdkEpoch = opencodeClient.getSdkClient()
    return childStores.configure({
      bootstrapConcurrency: 2,
      isCurrentScope: () => getRuntimeKey() === expectedRuntimeKey && opencodeClient.getSdkClient() === sdkEpoch,
      onBootstrap: async (context: DirectoryBootstrapContext) => {
        const { directory } = context
        const isCurrent = context.isCurrent
        const store = childStores.getChild(directory)
        if (!store || !isCurrent()) return

        const failBootstrap = async () => {
          if (!isCurrent()) return
          const files = getRegisteredRuntimeAPIs()?.files
          if (files) {
            try {
              await files.listDirectory(directory)
            } catch (error) {
              if (isFilesystemError(error) && error.reason === "os-permission") throw error
            }
          }
          throw new Error(`Directory bootstrap failed for ${directory}`)
        }
        let initializationAttempt = 0

        const runBootstrap = async (attempt: number): Promise<"complete" | "failed" | "stale"> => {
          if (!isCurrent()) return "stale"
          const currentAttempt = ++initializationAttempt
          const globalState = useGlobalSyncStore.getState()
          const bootstrap = bootstrapDirectory({
            directory,
            store,
            set: (patch) => {
              if (!isCurrent()) return
              store.setState(patch)
              if (patch.session_status) {
                applyGlobalSessionStatusSnapshot(directory, patch.session_status, getDirectoryOwnedSessionIds(directory, store.getState().session))
              }
              if (patch.session || patch.message) {
                ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
              }
            },
            isStale: () => !isCurrent() || currentAttempt !== initializationAttempt,
            global: {
              config: globalState.config,
              projects: globalState.projects,
              path: globalState.path,
            },
            loadSessions: async (dir) => {
              if (!isCurrent()) return
              const baselineRevision = store.getState().sessionRevision ?? 0
              const { active } = splitGlobalSessionsByArchived(
                await listGlobalSessionPages(listSessionPage, {
                  directory: dir,
                  pageSize: 500,
                  onPage: (page) => {
                    if (!isCurrent()) return
                    const { active } = splitGlobalSessionsByArchived(page)
                    const current = store.getState()
                    const { sessions } = mergeBootstrapSessions(
                      active.filter((session) => !session.parentID), active, current.session, {
                        baselineRevision,
                        partial: true,
                        eventRevision: current.sessionEventRevision,
                        deletedRevision: current.sessionDeletedRevision,
                      },
                    )
                    if (sessions === current.session) return
                    store.setState({ session: sessions, limit: Math.max(sessions.length, 50) })
                    ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
                  },
                }),
              )
              const allSessions = active
                .filter((s) => !!s?.id)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const rootSessions = allSessions.filter((s) => !s.parentID)
              if (!isCurrent()) return

              const current = store.getState()
              const { sessions, rootCount } = mergeBootstrapSessions(rootSessions, allSessions, current.session, {
                baselineRevision,
                eventRevision: current.sessionEventRevision,
                deletedRevision: current.sessionDeletedRevision,
              })
              store.setState({
                session: sessions,
                sessionTotal: rootCount,
                sessionListSource: "authoritative",
                limit: Math.max(sessions.length, 50),
              })
              ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
            },
          })
          context.trackInitialization(bootstrap.environment.then((result) => {
            if (result === "failed") return failBootstrap()
          }))
          const result = await bootstrap.sessions
          if (!isCurrent()) return "stale"
          if (result !== "complete") return result

          if (isVSCodeRuntime() && isCurrent()) {
            const state = store.getState()
            if (state.session.length === 0 && attempt < 5) {
              console.warn(`[bootstrap] sessions empty for ${directory} after attempt ${attempt + 1}; retrying in 2s`)
              await new Promise((r) => setTimeout(r, 2000))
              if (!isCurrent()) return "stale"
              store.setState({ status: "loading" as const })
              return runBootstrap(attempt + 1)
            } else if (state.session.length === 0) {
              console.warn(`[bootstrap] sessions empty for ${directory} after ${attempt + 1} attempts; giving up`)
            }
          }
          return "complete"
        }

        const result = await runBootstrap(0)
        if (result === "failed") await failBootstrap()

        if (result === "complete") {
          useSessionUIStore.getState().adoptAuthoritativeSessionDirectory()
        }
      },
      onDispose: (directory) => {
        messageLoader.invalidateDirectory(directory)
        lastStatusPollAtByDirectoryRef.current.delete(directory)
        statusPollBackoffByDirectoryRef.current.delete(directory)
        lastFullResyncAtByDirectoryRef.current.delete(directory)
        childDiscoveryDueAtByDirectoryRef.current.delete(directory)
        staleResyncBackoffByDirectoryRef.current.delete(directory)
        childDiscoveryBackoffByDirectoryRef.current.delete(directory)
      },
      isLoadingSessions: () => false,
    })
  }, [childStores, messageLoader, props.sdk, routingIndex])

  useEffect(() => {
    let previous = knownSpaceIds(useSpacesStore.getState())
    let generation = spacesRuntimeGeneration()
    return useSpacesStore.subscribe((state) => {
      const next = knownSpaceIds(state)
      const reset = spacesRuntimeGeneration() !== generation
      generation = spacesRuntimeGeneration()
      const gone = reset ? [] : spaceIdsGone(previous, next)
      previous = next
      if (gone.length === 0) return
      const goneIds = new Set(gone)
      for (const directory of Array.from(childStores.children.keys())) {
        const spaceId = spaceIdOfDirectory(directory)
        if (spaceId !== null && goneIds.has(spaceId)) childStores.forgetDirectory(directory)
      }
      if (followCurrentChatToArchive(goneIds)) return
      const unsubscribe = useGlobalSessionsStore.subscribe(() => {
        if (followCurrentChatToArchive(goneIds)) unsubscribe()
      })
    })
  }, [childStores])

  useEffect(() => {
    const generation = ++globalBootstrapGeneration
    bootingRoot = true
    const globalActions = useGlobalSyncStore.getState().actions
    bootstrapGlobal((patch) => {
      if (globalBootstrapGeneration === generation) {
        globalActions.set(patch)
      }
    })
      .then(() => {
        if (globalBootstrapGeneration === generation) {
          bootedAt = Date.now()
        }
      })
      .finally(() => {
        if (globalBootstrapGeneration === generation) {
          bootingRoot = false
        }
      })
    return () => {
      if (globalBootstrapGeneration === generation) {
        bootingRoot = false
      }
    }
  }, [props.sdk])

  useEffect(() => {
    const unsubscribeQueueEvents = subscribeMessageQueueSync(runtimeKey)
    const unsubscribeSessionAdmission = subscribeSessionAdmission()
    const unsubscribeAutoReviewEvents = subscribeAutoReviewSync(runtimeKey)
    const unsubscribePrWatchEvents = subscribePrWatchSync(runtimeKey)
    const unsubscribeExtensionWaitEvents = subscribeExtensionWaitsSync(runtimeKey)
    const unsubscribeLaterPageEvents = subscribeLaterPagesSync(runtimeKey)
    const unsubscribeSessionWarming = subscribeSessionWarmingSync(runtimeKey)
    const unsubscribeSessionTodos = subscribeSessionTodosSync(runtimeKey)
    const unsubscribeFolderEvents = subscribeSessionFoldersSync(runtimeKey)
    const unsubscribeDraftEvents = subscribeSessionDraftsSync(runtimeKey)
    const unsubscribeSpaceModes = subscribeSpacePermissionModes(runtimeKey)
    const unsubscribePermissionPolicy = subscribePermissionPolicySync(
      runtimeKey,
      (event) => handleEvent("global", event, childStores, routingIndex, runtimeKey),
    )
    const unsubscribeControlStream = subscribeControlStreamSync(runtimeKey, (event) => {
      if (event.type === "session.patched") handleEvent("global", event, childStores, routingIndex, runtimeKey)
      else applyControlStreamOnlyEvent(event)
    })
    const unsubscribeSpaceCatalogs = subscribeSpaceCatalogs(runtimeKey)
    const unsubscribeSpaceSessionProject = subscribeSpaceSessionProject(runtimeKey)
    const resyncAfterStreamGap = (reason: SessionMaterializationReason) => {
      messageLoader.markHistoryStale()
      const gapEndedAt = Date.now()
      for (const dir of childStores.children.keys()) {
        triggerDirectoryResync(dir, reason)
        childDiscoveryDueAtByDirectoryRef.current.set(dir, gapEndedAt)
      }
      void reconcileActivityAfterGap(childStores)
      notifyStreamGap(runtimeKey)
    }
    const pipeline = createEventPipeline({
      sdk: props.sdk,
      transport: messageStreamTransport,
      routeDirectory: (directory, payload) => {
        return resolveDirectoryFromRoutingIndex(routingIndex, directory, payload, childStores)
      },
      onStreamActivity: () => {
        lastStreamActivityAtRef.current = Date.now()
      },
      onEvents: (directory, payloads) => {
        const batch = createDirectoryEventBatch()
        try {
          for (const payload of payloads) {
            dispatchVSCodeRuntimeNotificationEvent(directory, payload)
            if (payload.type === "installation.update-available") {
              const { version } = payload.properties
              if (version) dispatchOpenCodeUpdateAvailable({ version })
            }
            handleEvent(directory, payload, childStores, routingIndex, runtimeKey, false, currentDirectoryRef.current, batch)
          }
        } finally {
          publishDirectoryEventBatch(batch)
        }
      },
      onSpaceStream: ({ spaceId, status }) => {
        useSpacesStore.getState().noteStream(spaceId, status)
        if (status === "connected" && isSpaceStopped(spaceId)) {
          void refreshSpacesJourney().catch(() => undefined)
        }
        if (status !== "connected") {
          if (useSpacesStore.getState().journey?.get(spaceId)?.state === "running") {
            void refreshSpacesJourney().catch(() => undefined)
          }
          return
        }
        const directories = Array.from(useGlobalSessionsStore.getState().sessionsByDirectory.keys())
          .filter((directory) => spaceIdOfDirectory(directory) === spaceId)
        const spaceDirectory = useSpacesStore.getState().spaces.get(spaceId)?.directory
        if (spaceDirectory) directories.push(spaceDirectory)
        if (directories.length === 0) return
        void useGlobalSessionsStore.getState().refreshSessionsForDirectories(directories).catch(() => undefined)
      },
      onSpaceProgress: (progress) => {
        const known = useSpacesStore.getState().noteProgress(progress)
        if (known && progress.step !== "ready" && progress.step !== "failed") return
        void refreshSpacesJourney().catch(() => undefined)
      },
      onSpaceTaskTitle: (spaceId, taskTitle) => {
        if (runtimeKey !== getRuntimeKey()) return
        if (!useSpacesStore.getState().noteTaskTitle(spaceId, taskTitle)) void refreshSpacesJourney().catch(() => undefined)
      },
      onSpaceSetup: () => {
        void refreshSpacesJourney().catch(() => undefined)
      },
      onSpacePermissionStream: (spaceId) => {
        if (runtimeKey !== getRuntimeKey()) return
        void usePermissionStore.getState().refreshSpaceModes(spaceId)
      },
      onReconnect: ({ replayReset, replayed }) => {
        if (useUIStore.getState().isolatedSpacesEnabled && !isVSCodeRuntime()) {
          void refreshSpacesJourney().catch(() => undefined)
        }
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        renewWatchedFiles()
        void runBackgroundNetworkTask(() => refreshBackgroundImages(() => opencodeClient.listRunningImageJobs()))
          .catch(() => undefined)
        useConfigStore.setState({
          isConnected: true,
          hasEverConnected: true,
          connectionPhase: "connected",
        })
        const isFirstConnect = !pipelineHasConnectedRef.current
        pipelineHasConnectedRef.current = true
        if (!replayReset && isFirstConnect && !pipelineDisconnectedBeforeFirstConnectRef.current) {
          return
        }
        if (!replayReset && isRecentBoot()) {
          return
        }
        if (replayed) {
          for (const dir of childStores.children.keys()) triggerDirectoryResync(dir, "stream-replayed")
          void reconcileActivityAfterGap(childStores)
          return
        }
        resyncAfterStreamGap("stream-reconnect")
      },
      onDisconnect: (reason) => {
        if (!pipelineHasConnectedRef.current) {
          pipelineDisconnectedBeforeFirstConnectRef.current = true
        }
        const { hasEverConnected } = useConfigStore.getState()
        useConfigStore.setState({
          isConnected: false,
          connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
          lastDisconnectReason: reason,
        })
      },
      onTransportSwitch: () => {
        void useMessageQueueStore.getState().resync().catch(() => undefined)
        resyncAfterStreamGap("transport-switch")
      },
    })
    pipelineReconnectRef.current = pipeline.reconnect
    return () => {
      if (pipelineReconnectRef.current === pipeline.reconnect) {
        pipelineReconnectRef.current = null
      }
      pipeline.cleanup()
      unsubscribeQueueEvents()
      unsubscribeSessionAdmission()
      unsubscribeAutoReviewEvents()
      unsubscribePrWatchEvents()
      unsubscribeExtensionWaitEvents()
      unsubscribeLaterPageEvents()
      unsubscribeSessionWarming()
      unsubscribeSessionTodos()
      unsubscribeFolderEvents()
      unsubscribeDraftEvents()
      unsubscribeSpaceModes()
      unsubscribePermissionPolicy()
      unsubscribeControlStream()
      unsubscribeSpaceCatalogs()
      unsubscribeSpaceSessionProject()
    }
  }, [props.sdk, childStores, messageLoader, routingIndex, messageStreamTransport, runtimeKey, triggerDirectoryResync])

  useEffect(() => {
    let stopped = false
    let running = false
    const statusPollBackoff = new Map<string, number>()
    statusPollBackoffByDirectoryRef.current = statusPollBackoff
    const staleResyncBackoff = staleResyncBackoffByDirectoryRef.current
    const childDiscoveryBackoff = childDiscoveryBackoffByDirectoryRef.current

    const discoverChildSessions = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      parentSessionIds: string[],
    ) => {
      if (parentSessionIds.length === 0) return
      if (childDiscoveryDirectories.has(directory)) return
      childDiscoveryDirectories.add(directory)
      try {
        const listed: GlobalSessionRecord[] = []
        for (const parentID of parentSessionIds) {
          listed.push(...await listGlobalSessionPages(listSessionPage, { directory, parentID, pageSize: 200 }))
          if (stopped || childStores.getChild(directory) !== store) return
        }
        const { active: allSessions } = splitGlobalSessionsByArchived(listed)
        childDiscoveryBackoff.delete(directory)
        const state = store.getState()
        const globalEntities = useGlobalSessionsStore.getState().entityById
        const newChildSessions = selectNewChildSessions(
          allSessions,
          new Set(state.session.map((s) => s.id)),
          new Set(parentSessionIds),
          (sessionId) => Boolean(globalEntities.get(sessionId)?.time?.archived),
        )
        if (newChildSessions.length === 0) return
        const parentIdsForMaterialization = new Set<string>()
        for (const session of newChildSessions) {
          if (session.parentID) parentIdsForMaterialization.add(session.parentID)
        }
        store.setState((state: DirectoryStore) => {
          const sessions = [...state.session, ...newChildSessions].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          )
          return { session: sessions, limit: Math.max(sessions.length, 50) }
        })
        for (const pid of parentIdsForMaterialization) {
          enqueueSessionMaterialization(directory, pid, childStores, { reason: "child-session-discovered" })
        }
      } catch {
        if (!stopped && childStores.getChild(directory) === store) {
          recordWatchdogReadFailure(childDiscoveryBackoff, directory, CHILD_SESSION_DISCOVERY_RETRY_MS)
          childDiscoveryDueAtByDirectoryRef.current.set(directory, Date.now())
        }
      } finally {
        childDiscoveryDirectories.delete(directory)
      }
    }

    const pollDirectoryStatuses = async (
      directory: string,
      store: StoreApi<DirectoryStore>,
      candidateSessionIds: string[],
    ) => {
      const polling = statusPollingDirectories
      if (polling.has(directory)) return
      polling.add(directory)
      const recordFailure = () => {
        if (stopped || childStores.getChild(directory) !== store) return
        const previousDelay = statusPollBackoff.get(directory) ?? ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS
        statusPollBackoff.set(directory, Math.min(previousDelay * 2, ACTIVE_SESSION_STATUS_POLL_MAX_BACKOFF_MS))
        lastStatusPollAtByDirectoryRef.current.set(directory, Date.now())
      }
      try {
        const before = store.getState()
        const statuses = await runBackgroundNetworkTask(() => resyncDirectorySessionStatuses(directory, store, candidateSessionIds, "monotonic"), "active-session")
        if (statuses === undefined) return
        if (statuses === null) {
          recordFailure()
          return
        }
        if (stopped || childStores.getChild(directory) !== store) return
        statusPollBackoff.delete(directory)
        const needsSnapshot = candidateSessionIds.some((sessionId) => (
          needsSnapshotAfterStatusPoll(before, sessionId, statuses[sessionId])
        ))
        if (needsSnapshot) {
          triggerDirectoryResync(directory, "stale-status-resync")
        }
      } catch {
        recordFailure()
      } finally {
        polling.delete(directory)
      }
    }

    const tick = () => {
      if (running || stopped) return
      running = true
      void Promise.resolve()
        .then(() => {
          if (stopped) return
          const now = Date.now()
          for (const [directory, store] of childStores.children.entries()) {
            if (isSpaceDirectoryStopped(directory)) continue
            const state = store.getState()
            const candidateSessionIds = getActiveSessionCandidateIds(directory, state)
            if (candidateSessionIds.length === 0) {
              lastStatusPollAtByDirectoryRef.current.delete(directory)
              statusPollBackoff.delete(directory)
              lastFullResyncAtByDirectoryRef.current.delete(directory)
              staleResyncBackoff.delete(directory)
              childDiscoveryBackoff.delete(directory)
              const childDiscoveryDueAt = childDiscoveryDueAtByDirectoryRef.current.get(directory)
              if (childDiscoveryDueAt !== undefined && now - childDiscoveryDueAt >= CHILD_SESSION_DISCOVERY_WAIT_MS) {
                childDiscoveryDueAtByDirectoryRef.current.delete(directory)
              }
              continue
            }

            const liveSessionIds = getLiveSessionCandidateIds(state)
            const lastStatusPollAt = lastStatusPollAtByDirectoryRef.current.get(directory) ?? 0
            const streamHealthy = now - lastStreamActivityAtRef.current < ACTIVE_SESSION_STALE_EVENT_MS
            const statusPollInterval = statusPollBackoff.get(directory)
              ?? (streamHealthy ? ACTIVE_SESSION_STATUS_POLL_HEALTHY_INTERVAL_MS : ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS)
            if (liveSessionIds.length > 0 && now - lastStatusPollAt >= statusPollInterval) {
              lastStatusPollAtByDirectoryRef.current.set(directory, now)
              void pollDirectoryStatuses(directory, store, liveSessionIds).catch(() => undefined)
            }

            const lastFullResyncAt = lastFullResyncAtByDirectoryRef.current.get(directory) ?? 0
            if (now >= (staleResyncBackoff.get(directory)?.retryAt ?? 0)
              && shouldTriggerStaleResync(lastStreamActivityAtRef.current, lastFullResyncAt, now)) {
              pipelineReconnectRef.current?.("active_stream_stale")
              triggerDirectoryResync(directory, "stale-status-resync")
              childDiscoveryDueAtByDirectoryRef.current.set(directory, now)
            }

            const childDiscoveryDueAt = childDiscoveryDueAtByDirectoryRef.current.get(directory)
            if (
              childDiscoveryDueAt !== undefined
              && !childDiscoveryDirectories.has(directory)
              && now >= (childDiscoveryBackoff.get(directory)?.retryAt ?? 0)
            ) {
              if (liveSessionIds.length > 0) {
                childDiscoveryDueAtByDirectoryRef.current.delete(directory)
                void discoverChildSessions(directory, store, liveSessionIds)
              } else if (now - childDiscoveryDueAt >= CHILD_SESSION_DISCOVERY_WAIT_MS) {
                childDiscoveryDueAtByDirectoryRef.current.delete(directory)
              }
            }
          }
        })
        .finally(() => {
          running = false
          if (stopped) {
            statusPollingDirectories.clear()
          }
        })
    }

    const interval = setInterval(tick, ACTIVE_SESSION_WATCHDOG_INTERVAL_MS)
    tick()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [childStores, props.sdk, triggerDirectoryResync, runtimeKey])

  useEffect(() => {
    let seedExpiryTimer: ReturnType<typeof setTimeout> | undefined
    if (props.directory) {
      const store = childStores.ensureChild(props.directory, {
        priority: "selected",
        reason: "current-directory",
      })
      const statusSeed = getRuntimeLiveStatusSeed(getRuntimeKey(), props.directory)
      if (statusSeed) {
        store.setState((state: DirectoryStore) => ({
          session_status: {
            ...state.session_status,
            [statusSeed.sessionId]: state.session_status[statusSeed.sessionId] ?? statusSeed.status,
          },
        }))
        seedExpiryTimer = setTimeout(() => {
          store.setState((state: DirectoryStore) => {
            if (state.session_status[statusSeed.sessionId] !== statusSeed.status) {
              return state
            }
            return {
              session_status: {
                ...state.session_status,
                [statusSeed.sessionId]: { type: "idle" as const },
              },
            }
          })
        }, LIVE_STATUS_TTL_MS)
      }
      ingestDirectoryStateIntoRoutingIndex(routingIndex, props.directory, store.getState())
    }
    return () => {
      if (seedExpiryTimer) clearTimeout(seedExpiryTimer)
    }
  }, [props.directory, childStores, routingIndex])

  useEffect(() => messageLoader.startCacheRetention({
    isCurrent: () => getRuntimeKey() === runtimeKey,
    isViewed: ({ directory, sessionID }) => isSessionCacheViewed(directory, sessionID),
    isActive: ({ directory, sessionID }) => {
      const live = useGlobalSessionStatusStore.getState().statusById.get(sessionID)
      return live?.directory === directory && live.status.type !== "idle"
    },
    releaseDerivedCache: ({ directory, sessionID }) => {
      const store = childStores.getChild(directory)
      if (store) dropCachedSessionMessageRecordsSnapshots(store, [sessionID])
    },
  }), [childStores, messageLoader, runtimeKey])

  useEffect(() => {
    setImperativeSessionMessageLoader(messageLoader)
    setSyncRefs(props.sdk, childStores, props.directory, (sessionID, dir) => {
      setIndexedSessionDirectory(routingIndex, sessionID, dir)
    })
    setActionRefs(
      childStores,
      () => opencodeClient.getDirectory() || props.directory,
      (directory, sessionID, messageID) => {
        enqueueSessionMaterialization(directory, sessionID, childStores, {
          reason: "settled-running-tool",
          messageID,
        })
      },
    )
    return () => {
      if (getImperativeSessionMessageLoader() === messageLoader) {
        setImperativeSessionMessageLoader(null)
      }
    }
  }, [props.sdk, props.directory, childStores, messageLoader, routingIndex])

  useEffect(() => {
    if (messageLoaderDisposalTimerRef.current) {
      clearTimeout(messageLoaderDisposalTimerRef.current)
      messageLoaderDisposalTimerRef.current = null
    }
    messageLoader.activate()
    return () => {
      messageLoaderDisposalTimerRef.current = setTimeout(() => {
        messageLoaderDisposalTimerRef.current = null
        messageLoader.dispose()
        childStores.disposeAll()
      }, 0)
    }
  }, [childStores, messageLoader])

  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    updateStreamingState(store.getState())
    const unsubscribe = store.subscribe((state, previous) => {
      updateChangedStreamingSessions(state, previous)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return (
    <SyncContext.Provider value={system}>
      <SyncRuntimeContext.Provider value={runtime}>
        {props.children}
      </SyncRuntimeContext.Provider>
    </SyncContext.Provider>
  )
}

export { useSyncRuntime } from "./sync-runtime-context"
export { useAllSessionStatuses, useAllLiveSessions, useLiveSessionsExcluding, useSessions, useSessionStartTimes, useParentSession, useSession, useSessionSelector, useSessionDirectory } from "./live-session-hooks"
export { MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS, applySessionStatusSnapshot, maybePollStatusAfterMessageCompletion, needsSnapshotAfterStatusPoll } from "./session-status-recovery"
export { setActiveSession, setExternallyViewedSession } from "./viewed-sessions"
export { shouldTriggerStaleResync } from "./sync-watchdog-policy"
export { createEventRoutingIndex } from "./event-routing-index"
export { resyncBlockingRequestsForDirectory, resyncBlockingRequestsForActiveDirectory } from "./blocking-request-recovery"
export { reconcileActivityAfterGap } from "./session-reconnect-recovery"
export { wakeDormantLocations } from "./dormant-locations"
export { handleEvent } from "./sync-event-dispatch"
export { interruptedTurnToolParts, markRecordedInterruptedTurn } from "./interrupted-turn-recovery"
export { useDirectoryStore, useSessionMessageLoader, useSessionMessageLoadState, useDirectorySync, useSyncDirectory, useChildStoreManager } from "./directory-sync-hooks"
export { useSessionMessages, useSessionMessagesSelector, useSessionMessagesResolved, useSessionPartsForMessages, useSessionRenderable, useUserMessageHistory } from "./session-message-hooks"
export { useSessionStatus, useSessionStatusSnapshotReady, useSessionPermissions, useSessionBlockingRequests, collectComposerForms, useScopedBlockingPermissions, useScopedBlockingForms, useRecoveredQuestions } from "./session-request-hooks"
export { buildSessionMessageRecordsSnapshot, readSessionMessageRecordsSnapshot, useSessionMessageRecords } from "./session-message-records"
